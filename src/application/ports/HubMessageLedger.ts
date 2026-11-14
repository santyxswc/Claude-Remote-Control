/**
 * Which topic each message the hub sent with buttons (or as a status)
 * belongs to (F14). An edit, a pin or a tap is accepted only for a message
 * of the session's own topic.
 */
export interface HubMessageLedger {
  record(chatId: string, messageId: string, topicId: string, at: number): void
  topicOf(chatId: string, messageId: string): string | undefined
  /** Forgets entries older than `before`; returns how many. */
  prune(before: number): number
}
