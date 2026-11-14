import type { PermissionPrompts } from '../permissions/PermissionPrompts.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PermissionStore } from '../ports/PermissionStore.ts'

export interface LocalResolution {
  readonly toolName: string
  /** Narrows the match to a request whose input preview contains this text. */
  readonly inputFragment?: string
}

export interface MarkPermissionResolvedLocallyDeps {
  readonly store: PermissionStore
  readonly prompts: PermissionPrompts
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/**
 * The tool ran, so its prompt was answered at the terminal: the oldest
 * matching open request is closed and its buttons removed. Claude Code sends
 * no such signal over the channel; F4 calls this from a `PostToolUse` hook.
 */
export class MarkPermissionResolvedLocally {
  constructor(private readonly deps: MarkPermissionResolvedLocallyDeps) {}

  async execute(resolution: LocalResolution): Promise<boolean> {
    const fragment = resolution.inputFragment
    const match = this.deps.store
      .listOpen()
      .find(
        (request) =>
          request.session === this.deps.session &&
          request.toolName === resolution.toolName &&
          (fragment === undefined || request.inputPreview.includes(fragment)),
      )
    if (match === undefined) return false

    const now = this.deps.clock.now()
    const resolved = match.resolveLocally(now)
    if (!this.deps.store.update(resolved, match.revision)) return false
    this.deps.audit.append({
      at: now,
      actor: 'terminal',
      event: 'permission.resolved_locally',
      details: { requestId: match.id, toolName: match.toolName },
    })
    this.deps.logger.info('permission request answered at the terminal', { requestId: match.id })
    await this.deps.prompts.refresh(resolved)
    return true
  }
}
