/** Sends outbound messages to the user's chat platform. */
export interface ChatGateway {
  /** Rejects when the message could not be delivered. */
  sendText(chatId: string, text: string): Promise<void>
}
