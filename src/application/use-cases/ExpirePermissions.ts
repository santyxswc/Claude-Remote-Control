import type { PermissionRequest } from '../../domain/permissions/PermissionRequest.ts'
import type { PermissionPrompts } from '../permissions/PermissionPrompts.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PermissionStore } from '../ports/PermissionStore.ts'

export interface ExpirePermissionsDeps {
  readonly store: PermissionStore
  readonly prompts: PermissionPrompts
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/**
 * Time-driven upkeep of open requests. No verdict is ever sent from here:
 * the terminal dialog stays authoritative for anything left unanswered.
 */
export class ExpirePermissions {
  constructor(private readonly deps: ExpirePermissionsDeps) {}

  /**
   * For this session's requests: past the TTL they expire; a high-risk
   * approval whose confirmation window passed shows Approve / Deny again.
   */
  async execute(): Promise<number> {
    const now = this.deps.clock.now()
    let expired = 0
    for (const stored of this.deps.store.listOpen()) {
      if (stored.session !== this.deps.session) continue
      if (stored.isDue(now)) {
        if (await this.#expire(stored, 'ttl')) expired += 1
        continue
      }
      const settled = stored.settle(now)
      if (settled !== stored && this.deps.store.update(settled, stored.revision)) {
        await this.deps.prompts.refresh(settled)
      }
    }
    return expired
  }

  /**
   * Requests relayed by another channel process can no longer be answered
   * from the chat: taps reach only the process that polls, and its verdicts
   * only reach its own session. Run when this process starts polling.
   */
  async expireOrphans(): Promise<number> {
    let expired = 0
    for (const stored of this.deps.store.listOpen()) {
      if (stored.session === this.deps.session) continue
      if (await this.#expire(stored, 'orphaned')) expired += 1
    }
    return expired
  }

  async #expire(stored: PermissionRequest, reason: 'ttl' | 'orphaned'): Promise<boolean> {
    const now = this.deps.clock.now()
    const expired = stored.expire(now)
    if (!this.deps.store.update(expired, stored.revision)) return false
    this.deps.audit.append({
      at: now,
      actor: 'system',
      event: 'permission.expired',
      details: { requestId: stored.id, toolName: stored.toolName, reason },
    })
    this.deps.logger.info('permission request expired', { requestId: stored.id, reason })
    await this.deps.prompts.refresh(expired)
    return true
  }
}
