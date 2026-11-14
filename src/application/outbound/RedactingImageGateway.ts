import { elideMiddle } from '../../domain/elideMiddle.ts'
import type { SecretRedactor } from '../../domain/redaction/SecretRedactor.ts'
import type { ImageGateway, OutboundImage } from '../ports/ImageGateway.ts'

/**
 * Images cannot be redacted, but their captions can: secrets are replaced
 * first, then the caption is fitted to the platform's limit.
 */
export class RedactingImageGateway implements ImageGateway {
  constructor(
    private readonly inner: ImageGateway,
    private readonly redactor: SecretRedactor,
    private readonly maxCaptionLength: number,
  ) {}

  sendImage(chatId: string, image: OutboundImage, caption: string): Promise<void> {
    const redacted = this.redactor.redact(caption).text
    return this.inner.sendImage(chatId, image, elideMiddle(redacted, this.maxCaptionLength))
  }
}
