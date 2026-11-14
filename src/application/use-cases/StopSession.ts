import type { BrakeRecord } from '../../domain/brake/BrakeRecord.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PermissionStore } from '../ports/PermissionStore.ts'
import type { InterruptResult, SessionController } from '../ports/SessionController.ts'
import type { EngageBrake } from './EngageBrake.ts'
import type { ResolvePermission } from './ResolvePermission.ts'

export interface StopSessionInput {
  /** An authenticated, allowlisted sender (the command runs after authentication). */
  readonly sender: SenderProfile
  readonly reason?: string
}

export interface StopReport {
  readonly brake: 'engaged' | 'already_engaged'
  /** Undefined when an existing flag cannot be read. */
  readonly record: BrakeRecord | undefined
  /** Pending requests of this session that got a `deny` verdict. */
  readonly denied: number
  /** `skipped` when the brake was already engaged. */
  readonly interrupt: InterruptResult | 'skipped'
}

export interface StopSessionDeps {
  readonly engage: EngageBrake
  readonly store: PermissionStore
  readonly resolve: ResolvePermission
  readonly controller: SessionController
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  /** This channel process; only its own requests can be answered. */
  readonly session: string
}

/**
 * `/stop`, the panic button. In this order: the brake flag (from then on
 * every tool call is refused by the PreToolUse hook and Claude stops), a
 * `deny` for every pending permission request of this session (the F3 path,
 * so each gets one verdict and its prompts lose their buttons), then a
 * best-effort interrupt of the running turn. A second `/stop` changes
 * nothing but still denies anything left pending.
 */
export class StopSession {
  constructor(private readonly deps: StopSessionDeps) {}

  async execute(input: StopSessionInput): Promise<StopReport> {
    const actor = `telegram:${input.sender.id}`
    const engaged = this.deps.engage.execute({
      actor,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    })
    const denied = await this.#denyPending(input.sender)
    const interrupt = engaged.outcome === 'engaged' ? await this.#interrupt() : 'skipped'

    if (engaged.outcome === 'engaged') {
      this.deps.audit.append({
        at: this.deps.clock.now(),
        actor,
        event: 'session.stopped',
        details: { denied, interrupt },
      })
    }
    return { brake: engaged.outcome, record: engaged.record, denied, interrupt }
  }

  async #denyPending(sender: SenderProfile): Promise<number> {
    const pending = this.deps.store
      .listOpen()
      .filter((request) => request.session === this.deps.session)
    let denied = 0
    for (const request of pending) {
      const outcome = await this.deps.resolve.execute({
        requestId: request.id,
        action: 'deny',
        sender,
        via: 'stop',
      })
      if (outcome === 'denied') denied += 1
    }
    return denied
  }

  async #interrupt(): Promise<InterruptResult> {
    try {
      return await this.deps.controller.interrupt()
    } catch (error) {
      this.deps.logger.error('the session controller failed', { error })
      return 'failed'
    }
  }
}
