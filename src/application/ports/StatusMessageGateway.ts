import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'

/** The status message was deleted or can no longer be edited. */
export class StatusMessageGoneError extends Error {
  constructor() {
    super('the status message is gone')
    this.name = 'StatusMessageGoneError'
  }
}

/** The platform asked us to slow down (Telegram: 429 with `retry_after`). */
export class StatusFloodWaitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`flood wait of ${retryAfterMs} ms`)
    this.name = 'StatusFloodWaitError'
  }
}

/**
 * The pinned status message (F9): plain text, sent and pinned without a
 * notification, then edited in place. Unlike the other gateways it never
 * waits out a flood limit: it throws `StatusFloodWaitError` and the caller
 * backs off, so status edits never hold anything else up. Only the
 * decorated gateway from `buildOutbound` (redaction, then one message) is
 * given to the application.
 */
export interface StatusMessageGateway {
  sendStatus(chatId: string, text: string): Promise<PromptRef>
  /** Editing to the same text is not an error. */
  editStatus(ref: PromptRef, text: string): Promise<void>
  pinStatus(ref: PromptRef): Promise<void>
  unpinStatus(ref: PromptRef): Promise<void>
}
