import { type BrakeRecord, sanitizeBrakeReason } from '../../domain/brake/BrakeRecord.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'

export interface EngageBrakeInput {
  /** `telegram:<sender id>` or `terminal`. */
  readonly actor: string
  readonly reason?: string
}

export type EngageBrakeResult =
  | { readonly outcome: 'engaged'; readonly record: BrakeRecord }
  /** `record` is undefined when the existing flag cannot be read. */
  | { readonly outcome: 'already_engaged'; readonly record: BrakeRecord | undefined }

export interface EngageBrakeDeps {
  readonly brake: BrakeFlag
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
}

/**
 * Sets the brake flag that the PreToolUse hook checks before every tool
 * call. Idempotent: an engaged brake is left as it is (who and since when
 * stay the first ones). The audit row records whether there was a reason
 * and its length, never its text.
 */
export class EngageBrake {
  constructor(private readonly deps: EngageBrakeDeps) {}

  execute(input: EngageBrakeInput): EngageBrakeResult {
    const current = this.deps.brake.status()
    if (current.engaged) return { outcome: 'already_engaged', record: current.record }

    const now = this.deps.clock.now()
    const reason = sanitizeBrakeReason(input.reason)
    const record: BrakeRecord = { engagedAt: now, actor: input.actor, reason }
    this.deps.brake.engage(record)
    this.deps.audit.append({
      at: now,
      actor: input.actor,
      event: 'brake.engaged',
      details: { reasonLength: reason?.length ?? 0 },
    })
    this.deps.logger.warn('the brake is engaged', { actor: input.actor })
    return { outcome: 'engaged', record }
  }
}
