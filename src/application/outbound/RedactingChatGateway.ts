import { elideMiddle } from '../../domain/elideMiddle.ts'
import type { SecretRedactor } from '../../domain/redaction/SecretRedactor.ts'
import type { ChatGateway, SendOptions, SendReceipt } from '../ports/ChatGateway.ts'

/**
 * Outermost decorator of the outbound pipeline: secrets are replaced before
 * the text goes anywhere else, in particular before chunking or fitting, so
 * a secret cannot straddle a cut and escape (M3). Reports only the count.
 */
export class RedactingChatGateway implements ChatGateway {
  constructor(
    private readonly inner: ChatGateway,
    private readonly redactor: SecretRedactor,
    /** One message's limit, for `fitToOneMessage`; in UTF-16 code units. */
    private readonly maxLength = Number.POSITIVE_INFINITY,
  ) {}

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    const redacted = this.redactor.redact(text)
    const fitted =
      options?.fitToOneMessage === true ? elideMiddle(redacted.text, this.maxLength) : redacted.text
    const receipt = await this.inner.sendText(chatId, fitted, options)
    return { parts: receipt.parts, redactions: receipt.redactions + redacted.count }
  }

  sendTyping(chatId: string): Promise<void> {
    return this.inner.sendTyping(chatId)
  }
}
