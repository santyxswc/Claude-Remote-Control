/** A file on the chat platform, ready to stream. */
export interface RemoteFile {
  /** What the platform says the size is, if it says; never trusted on its own. */
  readonly size: number | undefined
  /** The content. Stopping the iteration early cancels the download. */
  readonly chunks: AsyncIterable<Uint8Array>
}

/**
 * Downloads files people sent to the bot (F10). Errors never carry the
 * download URL (on Telegram it contains the bot token).
 */
export interface AttachmentSource {
  open(fileId: string, signal: AbortSignal): Promise<RemoteFile>
}
