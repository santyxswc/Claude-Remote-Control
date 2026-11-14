import type { AuditLog } from '../ports/AuditLog.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'

export type ResumeOutcome = 'released' | 'not_engaged'

export interface ResumeSessionDeps {
  readonly brake: BrakeFlag
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
}

/**
 * `/resume` and `telegram-bridge resume`: removes the brake flag, so tool
 * calls pass the PreToolUse hook again. Idempotent. It does not restart
 * Claude: the next prompt (from the terminal or the chat) does.
 */
export class ResumeSession {
  constructor(private readonly deps: ResumeSessionDeps) {}

  execute(actor: string): ResumeOutcome {
    if (!this.deps.brake.release()) return 'not_engaged'
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor,
      event: 'brake.released',
      details: {},
    })
    this.deps.logger.info('the brake is released', { actor })
    return 'released'
  }
}
