import type { Messages } from '../i18n/messages.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Logger } from '../ports/Logger.ts'
import type { ClaimPairing } from '../use-cases/ClaimPairing.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/** `/start <payload>`, optionally addressed as `/start@bot_name <payload>`. */
const START_WITH_PAYLOAD = /^\/start(?:@\w+)?\s+(\S+)\s*$/

/**
 * Step 2: the only thing an unknown sender can trigger. A deep-link
 * `/start <code>` is consumed here whatever the result. Only a successful
 * claim gets a reply; a wrong or expired code gets silence. Nothing about
 * the payload is logged.
 */
export class PairingClaimStep implements InboundStep {
  constructor(
    private readonly claim: ClaimPairing,
    private readonly chat: ChatGateway,
    private readonly messages: Messages,
    private readonly logger: Logger,
  ) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    const payload = START_WITH_PAYLOAD.exec(message.text ?? '')?.[1]
    if (payload === undefined || message.sender === undefined) {
      await next(message)
      return
    }

    const outcome = this.claim.execute({
      code: payload,
      sender: message.sender,
      sentAt: message.sentAt,
    })
    this.logger.info('pairing claim handled', { senderId: message.sender.id, outcome })
    if (outcome !== 'claimed') return

    try {
      await this.chat.sendText(message.chatId, this.messages.pairingClaimedReply)
    } catch (error) {
      this.logger.warn('could not acknowledge the pairing claim', { error })
    }
  }
}
