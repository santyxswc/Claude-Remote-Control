import { elideMiddle } from '../../domain/elideMiddle.ts'
import { cutAtLineBoundary, utf8Length } from '../../domain/lineCut.ts'
import type { SecretRedactor } from '../../domain/redaction/SecretRedactor.ts'
import type {
  DocumentGateway,
  DocumentReceipt,
  OutboundDocument,
} from '../ports/DocumentGateway.ts'

/**
 * Documents built from untrusted content (a diff, where `.env` values and
 * keys show up): the whole text is redacted first, and only then cut to the
 * size cap, between lines, with the caller's note (M3). The caption is
 * redacted and fitted the same way as an image caption.
 */
export class RedactingDocumentGateway implements DocumentGateway {
  constructor(
    private readonly inner: DocumentGateway,
    private readonly redactor: SecretRedactor,
    private readonly maxCaptionLength: number,
  ) {}

  async sendDocument(
    chatId: string,
    document: OutboundDocument,
    caption: string,
  ): Promise<DocumentReceipt> {
    const redacted = this.redactor.redact(document.text)
    const note = `${document.cutNote}\n`
    let text = redacted.text
    let cut = false
    if (utf8Length(text) > document.maxBytes) {
      text = `${cutAtLineBoundary(text, Math.max(0, document.maxBytes - utf8Length(note))).text}${note}`
      cut = true
    }
    const fittedCaption = elideMiddle(this.redactor.redact(caption).text, this.maxCaptionLength)
    const receipt = await this.inner.sendDocument(chatId, { ...document, text }, fittedCaption)
    return { redactions: redacted.count, bytes: receipt.bytes, cut }
  }
}
