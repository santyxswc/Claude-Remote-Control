import { sanitizeDisplayText, sanitizeUsername } from '../../domain/displayText.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { Messages } from '../i18n/messages.ts'
import type { ForwardContext, InboundMessage } from '../pipeline/InboundMessage.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { ChannelPort } from '../ports/ChannelPort.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { SessionActivity } from '../ports/SessionActivity.ts'

/** An authenticated text message, ready for the session. */
export interface ForwardableMessage extends InboundMessage {
  readonly sender: SenderProfile
  readonly text: string
}

export interface HandleInboundMessageDeps {
  readonly channel: ChannelPort
  readonly chat: ChatGateway
  readonly activity: SessionActivity
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly messages: Pick<Messages, 'queued' | 'deliveryFailed' | 'messageTooLong'>
  /** Observer: the message reached the session (activity and notice debounce listen). */
  readonly onForwarded?: () => void
}

export type ForwardOutcome = 'forwarded' | 'failed'

/**
 * Longest text forwarded to the session (L2). Telegram itself stops at 4,096;
 * this guards the other inbound adapters. Longer texts are refused and the
 * sender is told, never cut silently.
 */
export const MAX_INBOUND_TEXT_LENGTH = 16_384

/**
 * Delivers an authenticated text message to the Claude Code session as a
 * channel event, then acknowledges it in the chat with a "typing" status
 * (and a "queued" note when the session is known to be busy). The audit row
 * and the log carry ids and the length, never the text.
 */
export class HandleInboundMessage {
  constructor(private readonly deps: HandleInboundMessageDeps) {}

  async execute(message: ForwardableMessage): Promise<ForwardOutcome> {
    const { channel, chat, logger } = this.deps
    const senderId = message.sender.id
    if (message.text.length > MAX_INBOUND_TEXT_LENGTH) {
      logger.warn('refused an inbound text over the limit', {
        senderId,
        length: message.text.length,
      })
      await this.#tell(message.chatId, this.deps.messages.messageTooLong(MAX_INBOUND_TEXT_LENGTH))
      return 'failed'
    }
    try {
      await channel.emit({
        content: message.text,
        meta: {
          chat_id: message.chatId,
          message_id: message.messageId,
          user:
            sanitizeUsername(message.sender.username) ??
            sanitizeDisplayText(message.sender.displayName),
          ts: new Date(message.sentAt).toISOString(),
          ...contextMeta(message.forwardContext),
        },
      })
    } catch (error) {
      logger.error('could not deliver the message to the session', { senderId, error })
      await this.#tell(message.chatId, this.deps.messages.deliveryFailed)
      return 'failed'
    }

    const details = {
      senderId,
      messageId: message.messageId,
      length: message.text.length,
      ...(message.forwardContext === undefined ? {} : { kind: message.forwardContext.kind }),
    }
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: `telegram:${senderId}`,
      event: 'message.forwarded',
      details,
    })
    logger.info('forwarded a message to the session', details)

    try {
      await chat.sendTyping(message.chatId)
    } catch (error) {
      logger.warn('could not send the typing acknowledgement', { error })
    }
    if (this.deps.activity.current() === 'busy') {
      await this.#tell(message.chatId, this.deps.messages.queued)
    }
    // After the busy check: this message itself must not make the session look busy.
    this.deps.onForwarded?.()
    return 'forwarded'
  }

  async #tell(chatId: string, text: string): Promise<void> {
    try {
      await this.deps.chat.sendText(chatId, text)
    } catch (error) {
      this.deps.logger.warn('could not send a notice to the chat', { error })
    }
  }
}

/**
 * Extra attributes of the channel tag: why the text reaches the session.
 * Choices: the answer to an `ask_choice` (`choice_id`). Memory: how the owner answered a
 * `propose_memory` (`proposal_id`). Attachments: the local file.
 */
function contextMeta(context: ForwardContext | undefined): Record<string, string> {
  switch (context?.kind) {
    case undefined:
      return {}
    case 'choice':
      return { kind: 'choice', choice_id: context.choiceId }
    case 'memory':
      return { kind: 'memory', proposal_id: context.proposalId }
    case 'attachment':
      return {
        kind: 'attachment',
        attachment_path: context.path,
        attachment_name: context.name,
        attachment_mime: context.mime,
        attachment_size: String(context.size),
      }
  }
}
