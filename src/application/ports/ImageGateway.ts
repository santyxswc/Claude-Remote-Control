export interface OutboundImage {
  /** A local file we created; read during the upload. */
  readonly path: string
  /** The name the chat shows for a document. */
  readonly filename: string
  /** A compressed photo, or a document that keeps every pixel. */
  readonly as: 'photo' | 'document'
}

/**
 * Sends images to the chat. Like `ChatGateway`, the application only ever
 * gets the decorated gateway from `buildOutbound`: the caption is redacted
 * and fitted; the image itself is not (and cannot be) redacted.
 */
export interface ImageGateway {
  /** Rejects when the image was not delivered. */
  sendImage(chatId: string, image: OutboundImage, caption: string): Promise<void>
}
