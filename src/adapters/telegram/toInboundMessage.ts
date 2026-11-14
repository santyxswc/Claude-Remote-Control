import type { CallbackQuery, Message } from 'grammy/types'
import type { InboundCallback } from '../../application/callbacks/InboundCallback.ts'
import type { ChatKind, InboundMessage } from '../../application/pipeline/InboundMessage.ts'
import { sanitizeDisplayText, sanitizeUsername } from '../../domain/displayText.ts'
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

/** Maps a button tap. A tap on a message from an inline query has no chat and gets none. */
export function toInboundCallback(query: CallbackQuery): InboundCallback {
  const chat = query.message?.chat
  return {
    id: query.id,
    chatId: chat === undefined ? undefined : String(chat.id),
    chatKind: chat?.type as ChatKind | undefined,
    sender: toSender(query.from),
    data: query.data,
  }
}

/**
 * The name and username are chosen by whoever owns the account: sanitized
 * here, at the boundary, so nothing downstream sees controls or bidi tricks
 * (renderers sanitize again, for rows stored before this existed).
 */
function toSender(from: Message['from']): SenderProfile | undefined {
  if (from === undefined || from.is_bot) return undefined
  const displayName = sanitizeDisplayText(
    [from.first_name, from.last_name].filter(Boolean).join(' '),
  )
  return { id: String(from.id), username: sanitizeUsername(from.username), displayName }
}
