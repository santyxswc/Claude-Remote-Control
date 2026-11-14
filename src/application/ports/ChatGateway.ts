export interface SendOptions {
  /** Thread the message under this message of the same chat, if it still exists. */
  readonly replyTo?: string
}

/** What a send did, so callers can audit it without seeing the text again. */
export interface SendReceipt {
  /** Messages the text was delivered as (long texts are split). */
  readonly parts: number
  /** Secrets replaced before sending. */
  readonly redactions: number
}

/**
 * Sends outbound messages to the user's chat platform. The application only
 * ever receives the decorated gateway (redaction, then chunking); the raw
 * platform adapter stays inside the composition code.
 */
export interface ChatGateway {
  /** Plain text only. Rejects when the message could not be delivered. */
  sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt>
  /** Shows a short-lived "typing..." status. Rejects on failure; callers may ignore it. */
  sendTyping(chatId: string): Promise<void>
}
