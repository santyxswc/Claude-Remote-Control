import type { AuthorizeSender } from './AuthorizeSender.ts'

/**
 * May the session send to this chat? Only the private chat of a sender who
 * is allowlisted right now (in a private chat the chat id is the user id),
 * or one of the explicitly allowed extra chats (the dev listener's). Checked
 * on every call, so a revocation takes effect at once. Shared by every tool
 * that lets Claude send something to a chat.
 */
export class AuthorizeReplyTarget {
  constructor(
    private readonly authorize: AuthorizeSender,
    private readonly extraChatIds: ReadonlySet<string> = new Set(),
  ) {}

  execute(chatId: string): boolean {
    return this.extraChatIds.has(chatId) || this.authorize.execute(chatId)
  }
}

const PLAUSIBLE_CHAT_ID = /^-?[0-9]{1,20}$/

/** Whatever Claude passed is untrusted: keep it only if it looks like an id. */
export function auditableChatId(chatId: string): string {
  return PLAUSIBLE_CHAT_ID.test(chatId) ? chatId : 'invalid'
}
