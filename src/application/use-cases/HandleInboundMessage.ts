import type { SenderProfile } from '../../domain/Sender.ts'
import type { Messages } from '../i18n/messages.ts'
import type { InboundMessage } from '../pipeline/InboundMessage.ts'
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
  readonly messages: Pick<Messages, 'queued' | 'deliveryFailed'>
  /** Observer: the message reached the session (activity and notice debounce listen). */
  readonly onForwarded?: () => void
}

export type ForwardOutcome = 'forwarded' | 'failed'

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
    try {
      await channel.emit({
        content: message.text,
        meta: {
          chat_id: message.chatId,
          message_id: message.messageId,
          user: message.sender.username ?? message.sender.displayName,
          ts: new Date(message.sentAt).toISOString(),
        },
      })
    } catch (error) {
      logger.error('could not deliver the message to the session', { senderId, error })
      await this.#tell(message.chatId, this.deps.messages.deliveryFailed)
      return 'failed'
    }

    const details = { senderId, messageId: message.messageId, length: message.text.length }
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
