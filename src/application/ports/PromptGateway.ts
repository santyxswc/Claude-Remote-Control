import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'

export interface PromptButton {
  readonly label: string
  /** Opaque data the platform hands back on a tap (Telegram: at most 64 bytes). */
  readonly data: string
}

/** Rows of buttons; an empty keyboard removes the buttons. */
export type PromptKeyboard = readonly (readonly PromptButton[])[]

/**
 * Messages with buttons. Kept apart from `ChatGateway`: a prompt is never
 * split, because its buttons must sit on the message that shows it. Like
 * `ChatGateway`, the application only ever gets the redacting decorator.
 */
export interface PromptGateway {
  /** Plain text plus buttons, as one message. Rejects when it was not delivered. */
  sendPrompt(chatId: string, text: string, keyboard: PromptKeyboard): Promise<PromptRef>
  /** Replaces the text and the buttons of a prompt sent earlier. */
  editPrompt(ref: PromptRef, text: string, keyboard: PromptKeyboard): Promise<void>
  /** Acknowledges a tap so the client stops its spinner; `text` shows as a short toast. */
  answerCallback(callbackId: string, text?: string): Promise<void>
}
