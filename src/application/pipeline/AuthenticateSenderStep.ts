import { EventThrottle } from '../../domain/EventThrottle.ts'
import { DROPPED_LOG_WINDOW_MS } from '../../domain/inboundLimits.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { AuthorizeSender } from '../use-cases/AuthorizeSender.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * Step 3: authenticates by the sender's user id (never the chat id). Anything
 * from an unknown sender is dropped without a reply. The log line carries the
 * sender id only, never the message text, and at most once per sender per
 * window (with the number of drops it stood for), so a flood stays small.
 */
export class AuthenticateSenderStep implements InboundStep {
  constructor(
    private readonly authorize: AuthorizeSender,
    private readonly logger: Logger,
    private readonly clock: Clock,
    private readonly throttle = new EventThrottle(DROPPED_LOG_WINDOW_MS),
  ) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    const sender = message.sender
    if (sender === undefined || !this.authorize.execute(sender.id)) {
      const senderId = sender?.id ?? null
      const decision = this.throttle.record(senderId ?? `chat:${message.chatId}`, this.clock.now())
      if (decision.emit) {
        this.logger.info('dropped message from an unauthorized sender', {
          senderId,
          ...(decision.suppressed > 0 ? { suppressed: decision.suppressed } : {}),
        })
      }
      return
    }
    await next(message)
  }
}
