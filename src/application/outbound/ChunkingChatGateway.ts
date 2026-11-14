import { splitMessage } from '../../domain/splitMessage.ts'
import { EmptyMessageError, PartialDeliveryError } from '../errors.ts'
import type { ChatGateway, SendOptions, SendReceipt } from '../ports/ChatGateway.ts'

/**
 * Splits text longer than the platform limit and sends the parts in order,
 * one after another. Only the first part is threaded under `replyTo`. If a
 * part fails, nothing after it is sent and the error says how many parts
 * reached the chat.
 */
export class ChunkingChatGateway implements ChatGateway {
  constructor(
    private readonly inner: ChatGateway,
    /** The platform limit, in UTF-16 code units. */
    private readonly maxLength: number,
  ) {}

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    const chunks = splitMessage(text, this.maxLength)
    if (chunks.length === 0) throw new EmptyMessageError()
    let redactions = 0
    for (const [index, chunk] of chunks.entries()) {
      try {
        const receipt = await this.inner.sendText(chatId, chunk, index === 0 ? options : undefined)
        redactions += receipt.redactions
      } catch (error) {
        if (chunks.length === 1) throw error
        throw new PartialDeliveryError(index, chunks.length, error)
      }
    }
    return { parts: chunks.length, redactions }
  }

  sendTyping(chatId: string): Promise<void> {
    return this.inner.sendTyping(chatId)
  }
}
