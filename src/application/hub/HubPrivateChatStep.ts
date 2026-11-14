import type { SenderProfile } from '../../domain/Sender.ts'
import type { Messages } from '../i18n/messages.ts'
import type { InboundMessage } from '../pipeline/InboundMessage.ts'
import type { InboundHandler, InboundStep } from '../pipeline/InboundStep.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Logger } from '../ports/Logger.ts'

export type HubCommandHandler = (
  message: InboundMessage,
  sender: SenderProfile,
  place: string,
) => Promise<boolean>

/**
 * The last step of the hub's private-chat chain (F14), after pairing,
 * authentication and the rate limit: the private chat stays the control
 * channel for the hub's own commands (`/stop`, `/resume`, `/sessions`);
 * anything else gets a pointer to the group, since no session listens here.
 */
export class HubPrivateChatStep implements InboundStep {
  constructor(
    private readonly commands: HubCommandHandler,
    private readonly chat: ChatGateway,
    private readonly messages: Messages,
    private readonly logger: Logger,
  ) {}

  async handle(message: InboundMessage, _next: InboundHandler): Promise<void> {
    const sender = message.sender
    if (sender === undefined) return
    if (await this.commands(message, sender, message.chatId)) return
    try {
      await this.chat.sendText(message.chatId, this.messages.hubPrivateChatPointer)
    } catch (error) {
      this.logger.warn('the hub could not reply in the private chat', { error })
    }
  }
}
