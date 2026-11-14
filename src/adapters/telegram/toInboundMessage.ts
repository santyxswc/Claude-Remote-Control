import type { Message } from 'grammy/types'
import type { ChatKind, InboundMessage } from '../../application/pipeline/InboundMessage.ts'
import type { SenderProfile } from '../../domain/Sender.ts'

/**
 * Maps a Telegram message to the platform-neutral type. Ids arrive as JSON
 * numbers (Telegram keeps them below 2^53, so they are exact) and become
 * decimal strings here, before anything else touches them.
 */
export function toInboundMessage(message: Message): InboundMessage {
  return {
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    chatKind: message.chat.type as ChatKind,
    sender: toSender(message.from),
    text: message.text,
    sentAt: message.date * 1000,
  }
}

function toSender(from: Message['from']): SenderProfile | undefined {
  if (from === undefined || from.is_bot) return undefined
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ')
  return { id: String(from.id), username: from.username, displayName }
}
