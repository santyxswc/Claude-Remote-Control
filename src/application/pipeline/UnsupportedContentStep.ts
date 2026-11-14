import { EventThrottle } from '../../domain/EventThrottle.ts'
import { UNSUPPORTED_NOTICE_WINDOW_MS } from '../../domain/inboundLimits.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * Step 5: only text reaches the session, plus photos and files when F10 is
 * wired (acceptAttachments) and voice notes when F13 is wired (acceptVoice:
 * they are transcribed, or answered with how to enable that). Stickers,
 * video, audio files... are never forwarded. The sender is told once per
 * window, so an album gets one notice, not ten.
 */
export class UnsupportedContentStep implements InboundStep {
  constructor(
    private readonly chat: ChatGateway,
    private readonly notice: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /** True when F10 is wired: photos and files go on to the download. */
    private readonly acceptAttachments = false,
    /** True when F13 is wired: voice notes go on to the voice step. */
    private readonly acceptVoice = false,
    private readonly throttle = new EventThrottle(UNSUPPORTED_NOTICE_WINDOW_MS),
  ) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    if (
      message.text !== undefined ||
      (this.acceptAttachments && message.attachment !== undefined) ||
      (this.acceptVoice && message.voice !== undefined)
    ) {
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
