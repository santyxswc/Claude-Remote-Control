import { EventThrottle } from '../../domain/EventThrottle.ts'
import { DROPPED_LOG_WINDOW_MS } from '../../domain/inboundLimits.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * Step 1: only one-to-one chats are served in the MVP; anything else is
 * dropped silently. The log line is throttled per chat, so a busy group
 * cannot flood stderr.
 */
export class PrivateChatOnlyStep implements InboundStep {
  constructor(
    private readonly logger: Logger,
    private readonly clock: Clock,
    private readonly throttle = new EventThrottle(DROPPED_LOG_WINDOW_MS),
  ) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    if (message.chatKind !== 'private') {
      const decision = this.throttle.record(message.chatId, this.clock.now())
      if (decision.emit) {
        this.logger.info('dropped message from a non-private chat', {
          chatKind: message.chatKind,
          ...(decision.suppressed > 0 ? { suppressed: decision.suppressed } : {}),
        })
      }
      return
    }
    await next(message)
  }
}
