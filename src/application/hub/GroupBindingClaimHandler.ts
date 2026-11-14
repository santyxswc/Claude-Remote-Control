import type { Messages } from '../i18n/messages.ts'
import type { InboundMessage } from '../pipeline/InboundMessage.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Logger } from '../ports/Logger.ts'
import type { AuthorizeSender } from '../use-cases/AuthorizeSender.ts'
import type { ClaimGroupBinding } from '../use-cases/ClaimGroupBinding.ts'
import { parseBindCommand } from './groupBinding.ts'

export interface GroupBindingClaimDeps {
  readonly claim: Pick<ClaimGroupBinding, 'execute'>
  readonly authorize: AuthorizeSender
  readonly chat: ChatGateway
  readonly messages: Messages
  readonly logger: Logger
  readonly botUsername: string | undefined
}

/**
 * What `hub init` listens to while it waits (F14): `/bind <code>` in a group,
 * from the already paired owner (by sender id, like everything else). A
 * stranger cannot bind the bot to their group: their messages are dropped
 * before the code is even compared, so they cannot use up attempts either.
 * Only a forum supergroup can be bound; anything else is told so, once per
 * message, and only when it came from the owner.
 */
export class GroupBindingClaimHandler {
  constructor(private readonly deps: GroupBindingClaimDeps) {}

  async handle(message: InboundMessage): Promise<void> {
    const { deps } = this
    const code = parseBindCommand(message.text, deps.botUsername)
    const sender = message.sender
    if (
      code === undefined ||
      sender === undefined ||
      message.onBehalfOfChat === true ||
      message.chatKind === 'private' ||
      !deps.authorize.execute(sender.id)
    ) {
      return
    }
    if (message.chatKind !== 'supergroup' || message.isForum !== true) {
      await this.#reply(message.chatId, deps.messages.hubBindNotAForum)
      return
    }
    const outcome = deps.claim.execute({
      code,
      sender,
      sentAt: message.sentAt,
      group: { chatId: message.chatId, title: message.chatTitle ?? '' },
    })
    deps.logger.info('group binding claim handled', { senderId: sender.id, outcome })
    if (outcome === 'claimed') await this.#reply(message.chatId, deps.messages.hubBindClaimed)
  }

  async #reply(chatId: string, text: string): Promise<void> {
    try {
      await this.deps.chat.sendText(chatId, text)
    } catch (error) {
      this.deps.logger.warn('could not reply in the group', { error })
    }
  }
}
