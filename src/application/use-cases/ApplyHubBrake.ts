import type { SenderProfile } from '../../domain/Sender.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PermissionStore } from '../ports/PermissionStore.ts'
import type { InterruptResult, SessionController } from '../ports/SessionController.ts'
import type { ResolvePermission } from './ResolvePermission.ts'

export interface HubBrakeReport {
  readonly since: number | undefined
  readonly denied: number
  readonly interrupt: InterruptResult
}

export interface ApplyHubBrakeDeps {
  readonly brake: BrakeFlag
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
 * A spoke's half of `/stop` in hub mode (F14). The hub has already engaged
 * the brake file itself (the hook refuses every tool call from then on);
 * here this session does what only it can: a `deny` for each of its own
 * pending permission requests (the F3 path, one verdict each) and the
 * best-effort interrupt of its turn, at once.
 */
export class ApplyHubBrake {
  constructor(private readonly deps: ApplyHubBrakeDeps) {}

  async execute(sender: SenderProfile): Promise<HubBrakeReport> {
    const pending = this.deps.store
      .listOpen()
      .filter((request) => request.session === this.deps.session)
    const [outcomes, interrupt] = await Promise.all([
      Promise.all(
        pending.map((request) =>
          this.deps.resolve.execute({ requestId: request.id, action: 'deny', sender, via: 'stop' }),
        ),
      ),
      this.#interrupt(),
    ])
    const denied = outcomes.filter((outcome) => outcome === 'denied').length
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: `telegram:${sender.id}`,
      event: 'session.stopped',
      details: { denied, interrupt, via: 'hub' },
    })
    const status = this.deps.brake.status()
    return { since: status.engaged ? status.record?.engagedAt : undefined, denied, interrupt }
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
