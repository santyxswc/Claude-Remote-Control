import type { CallbackQuery, Message } from 'grammy/types'
import type { InboundCallback } from '../../application/callbacks/InboundCallback.ts'
import type {
  ChatKind,
  InboundAttachment,
  InboundMessage,
} from '../../application/pipeline/InboundMessage.ts'
import { sanitizeDisplayText, sanitizeUsername } from '../../domain/displayText.ts'
import type { SenderProfile } from '../../domain/Sender.ts'

/**
 * Maps a Telegram message to the platform-neutral type. Ids arrive as JSON
 * numbers (Telegram keeps them below 2^53, so they are exact) and become
 * decimal strings here, before anything else touches them.
 */
export function toInboundMessage(message: Message): InboundMessage {
  const attachment = toAttachment(message)
  return {
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    chatKind: message.chat.type as ChatKind,
    sender: toSender(message.from),
    text: message.text,
    sentAt: message.date * 1000,
    ...(attachment === undefined ? {} : { attachment }),
    ...(attachment === undefined || message.caption === undefined
      ? {}
      : { caption: message.caption }),
    ...(message.media_group_id === undefined ? {} : { mediaGroupId: message.media_group_id }),
    ...(message.voice === undefined
      ? {}
      : {
          // F13: only `voice` (a recorded note, Opus in Ogg). `audio` files and
          // `video_note`s stay unsupported.
          voice: {
            fileId: message.voice.file_id,
            duration: message.voice.duration,
            size: message.voice.file_size,
          },
        }),
    ...groupFields(message),
  }
}

/**
 * F14, groups only (a private chat gets none of these, so its mapping is
 * unchanged). `message_thread_id` is trusted only with `is_topic_message`:
 * replies in a supergroup carry a thread id without being in a topic.
 */
function groupFields(message: Message): {
  threadId?: string
  onBehalfOfChat?: true
  isForum?: true
  chatTitle?: string
} {
  if (message.chat.type === 'private') return {}
  const chat = message.chat as { is_forum?: boolean; title?: string }
  return {
    ...(message.is_topic_message === true && message.message_thread_id !== undefined
      ? { threadId: String(message.message_thread_id) }
      : {}),
    ...(message.sender_chat === undefined ? {} : { onBehalfOfChat: true as const }),
    ...(chat.is_forum === true ? { isForum: true as const } : {}),
    ...(chat.title === undefined ? {} : { chatTitle: sanitizeDisplayText(chat.title) }),
  }
}

/**
 * Photos and general files only (F10); voice notes have their own field
 * (F13); video, stickers... stay unsupported. Sizes and names are Telegram's
 * claims, checked later.
 */
function toAttachment(message: Message): InboundAttachment | undefined {
  if (message.photo !== undefined && message.photo.length > 0) {
    return {
      kind: 'photo',
      sizes: message.photo.map((size) => ({
        fileId: size.file_id,
        width: size.width,
        height: size.height,
        size: size.file_size,
      })),
    }
  }
  const document = message.document
  // An animation also fills `document` "for backward compatibility"; it is a video, not a file.
  if (document === undefined || message.animation !== undefined) return undefined
  return {
    kind: 'document',
    fileId: document.file_id,
    fileName: document.file_name,
    size: document.file_size,
  }
}

/** Maps a button tap. A tap on a message from an inline query has no chat and gets none. */
export function toInboundCallback(query: CallbackQuery): InboundCallback {
  const chat = query.message?.chat
  // An inaccessible message (date 0) carries no topic fields: no thread, so the hub refuses it.
  const tapped = query.message as { is_topic_message?: boolean; message_thread_id?: number }
  return {
    id: query.id,
    chatId: chat === undefined ? undefined : String(chat.id),
    chatKind: chat?.type as ChatKind | undefined,
    ...(query.message === undefined ? {} : { messageId: String(query.message.message_id) }),
    sender: toSender(query.from),
    data: query.data,
    ...(chat !== undefined &&
    chat.type !== 'private' &&
    tapped.is_topic_message === true &&
    tapped.message_thread_id !== undefined
      ? { threadId: String(tapped.message_thread_id) }
      : {}),
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
