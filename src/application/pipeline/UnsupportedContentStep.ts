import { EventThrottle } from '../../domain/EventThrottle.ts'
import { UNSUPPORTED_NOTICE_WINDOW_MS } from '../../domain/inboundLimits.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * Step 5: only text reaches the session for now (F10 and F13 add files and
 * voice). Anything else is never forwarded; the sender is told once per
 * window, so an album of ten photos gets one notice, not ten.
 */
export class UnsupportedContentStep implements InboundStep {
  constructor(
    private readonly chat: ChatGateway,
    private readonly notice: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly throttle = new EventThrottle(UNSUPPORTED_NOTICE_WINDOW_MS),
  ) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    if (message.text !== undefined) {
      await next(message)
      return
    }
    const key = message.sender?.id ?? message.chatId
    if (!this.throttle.record(key, this.clock.now()).emit) return
    try {
      await this.chat.sendText(message.chatId, this.notice)
    } catch (error) {
      this.logger.warn('could not send the text-only notice', { error })
    }
  }
}
