/**
 * Where a message goes: a chat and, in a forum supergroup, one topic (F14).
 *
 * The ports keep taking an opaque chat reference (a string), so the
 * single-session code paths are untouched. A topic is encoded into that
 * string as `<chat id>/<thread id>`; a plain chat id has no slash and means
 * "the whole chat", exactly as before. Only the Telegram adapter decodes it.
 */
export interface ConversationTarget {
  readonly chatId: string
  /** The forum topic (`message_thread_id`), if any. */
  readonly threadId: string | undefined
}

const CHAT_ID = /^-?[1-9][0-9]{0,19}$/
const THREAD_ID = /^[1-9][0-9]{0,15}$/

/** The opaque reference for one topic of a chat. Throws on ids that are not decimal ids. */
export function topicTarget(chatId: string, threadId: string): string {
  if (!CHAT_ID.test(chatId) || !THREAD_ID.test(threadId)) {
    throw new Error('a topic target needs a decimal chat id and thread id')
  }
  return `${chatId}/${threadId}`
}

/** Splits a reference; one without a well-formed `/<thread>` suffix is a plain chat. */
export function parseTarget(reference: string): ConversationTarget {
  const slash = reference.indexOf('/')
  if (slash < 0) return { chatId: reference, threadId: undefined }
  const chatId = reference.slice(0, slash)
  const threadId = reference.slice(slash + 1)
  if (!CHAT_ID.test(chatId) || !THREAD_ID.test(threadId)) {
    return { chatId: reference, threadId: undefined }
  }
  return { chatId, threadId }
}

export function isThreadId(value: string): boolean {
  return THREAD_ID.test(value)
}
