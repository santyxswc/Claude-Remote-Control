import { EventThrottle } from '../../domain/EventThrottle.ts'
import { BRAKE_NOTICE_WINDOW_MS } from '../../domain/inboundLimits.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * Just before delivery: while the brake is engaged nothing reaches the
 * session (a message would start a new turn). Commands run earlier in the
 * chain, so `/resume` and `/status` still work. The sender is told at most
 * once per window.
 */
export class BrakeGateStep implements InboundStep {
  constructor(
    private readonly brake: Pick<BrakeFlag, 'status'>,
    private readonly chat: ChatGateway,
    private readonly notice: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly throttle = new EventThrottle(BRAKE_NOTICE_WINDOW_MS),
  ) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    if (!this.brake.status().engaged) {
      await next(message)
      return
    }
    const key = message.sender?.id ?? message.chatId
    if (!this.throttle.record(key, this.clock.now()).emit) return
    this.logger.info('held a message: the brake is engaged', { senderId: message.sender?.id })
    try {
      await this.chat.sendText(message.chatId, this.notice)
    } catch (error) {
      this.logger.warn('could not send the brake notice', { error })
    }
  }
}
