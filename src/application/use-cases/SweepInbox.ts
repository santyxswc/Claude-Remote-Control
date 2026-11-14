import {
  DEFAULT_RETENTION,
  type RetentionPolicy,
  selectForDeletion,
} from '../../domain/attachments/inboxRetention.ts'
import type { AttachmentInbox } from '../ports/AttachmentInbox.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'

/**
 * Retention of incoming files (F10): files older than the TTL go, then the
 * oldest until the inbox fits the quota. Run when polling starts, after each
 * file kept and periodically. `orphans` removes the inboxes of other
 * sessions, run when this process takes the poller lock.
 */
export class SweepInbox {
  constructor(
    private readonly inbox: AttachmentInbox,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly policy: RetentionPolicy = DEFAULT_RETENTION,
  ) {}

  async execute(): Promise<number> {
    const doomed = selectForDeletion(await this.inbox.list(), this.clock.now(), this.policy)
    if (doomed.length === 0) return 0
    const removed = await this.inbox.remove(doomed)
    this.logger.info('removed old incoming files', { removed })
    return removed
  }

  async orphans(only?: ReadonlySet<string>): Promise<number> {
    const removed = await this.inbox.removeOtherSessions(only)
    if (removed > 0) this.logger.info('removed the inboxes of earlier sessions', { removed })
    return removed
  }
}
