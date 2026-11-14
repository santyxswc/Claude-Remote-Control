import type { SecretRedactor } from '../../domain/redaction/SecretRedactor.ts'
import type { ChatGateway, SendOptions, SendReceipt } from '../ports/ChatGateway.ts'

/**
 * Outermost decorator of the outbound pipeline: secrets are replaced before
 * the text goes anywhere else, in particular before chunking, so a secret
 * cannot straddle two chunks and escape both. Reports only the count.
 */
export class RedactingChatGateway implements ChatGateway {
  constructor(
    private readonly inner: ChatGateway,
    private readonly redactor: SecretRedactor,
  ) {}

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    const redacted = this.redactor.redact(text)
    const receipt = await this.inner.sendText(chatId, redacted.text, options)
    return { parts: receipt.parts, redactions: receipt.redactions + redacted.count }
  }

  sendTyping(chatId: string): Promise<void> {
    return this.inner.sendTyping(chatId)
  }
}
