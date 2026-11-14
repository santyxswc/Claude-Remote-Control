/** A text document built by the bridge (a `.diff`, F8), sent as a file. */
export interface OutboundDocument {
  /** The name the chat shows. */
  readonly filename: string
  /** The whole content; the redacting decorator redacts it, then cuts it to `maxBytes`. */
  readonly text: string
  /** UTF-8 bytes at most, note included; cut between lines only. */
  readonly maxBytes: number
  /** Appended (on its own line) when the content was cut. */
  readonly cutNote: string
}

export interface DocumentReceipt {
  /** Secrets replaced before sending. */
  readonly redactions: number
  /** Bytes sent. */
  readonly bytes: number
  /** The content was cut to fit `maxBytes`. */
  readonly cut: boolean
}

/**
 * Sends text documents. Like the other gateways, the application only ever
 * gets the decorated one from `buildOutbound`: the content and the caption
 * are redacted first, and only then fitted (M3), so a cut never leaves half
 * a secret. Rejects when the document was not delivered.
 */
export interface DocumentGateway {
  sendDocument(
    chatId: string,
    document: OutboundDocument,
    caption: string,
  ): Promise<DocumentReceipt>
}
