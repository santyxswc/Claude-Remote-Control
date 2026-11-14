import type { ChatGateway } from '../../application/ports/ChatGateway.ts'

export interface DevReply {
  readonly chat_id: string
  readonly text: string
}

export type DevReplyListener = (reply: DevReply) => void

/**
 * Development-only `ChatGateway`: instead of a chat platform, it hands each
 * reply to in-process listeners (the `/events` SSE stream of DevHttpInbound).
 * A reply with no listener connected is dropped, like a message nobody reads.
 */
export class DevChatGateway implements ChatGateway {
  readonly #listeners = new Set<DevReplyListener>()

  async sendText(chatId: string, text: string): Promise<void> {
    const reply: DevReply = { chat_id: chatId, text }
    for (const listener of this.#listeners) {
      listener(reply)
    }
  }

  /** Returns a function that removes the listener. */
  subscribe(listener: DevReplyListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
