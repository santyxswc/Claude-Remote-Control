import type { ChatGateway, SendOptions, SendReceipt } from '../../application/ports/ChatGateway.ts'

export interface DevReply {
  readonly chat_id: string
  readonly text: string
}

export type DevReplyListener = (reply: DevReply) => void

/**
 * Development-only `ChatGateway`: instead of a chat platform, it hands each
 * reply to in-process listeners (the `/events` SSE stream of DevHttpInbound).
 * A reply with no listener connected is dropped, like a message nobody reads.
 * Like the Telegram adapter, it is only used behind the outbound decorators.
 */
export class DevChatGateway implements ChatGateway {
  readonly #listeners = new Set<DevReplyListener>()

  async sendText(chatId: string, text: string, _options?: SendOptions): Promise<SendReceipt> {
    const reply: DevReply = { chat_id: chatId, text }
    for (const listener of this.#listeners) {
      listener(reply)
    }
    return { parts: 1, redactions: 0 }
  }

  /** There is no typing status to show on an SSE stream. */
  async sendTyping(_chatId: string): Promise<void> {}

  /** Returns a function that removes the listener. */
  subscribe(listener: DevReplyListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
