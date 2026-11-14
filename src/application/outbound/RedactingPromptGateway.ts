import { elideMiddle } from '../../domain/elideMiddle.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { SecretRedactor } from '../../domain/redaction/SecretRedactor.ts'
import type { PromptGateway, PromptKeyboard } from '../ports/PromptGateway.ts'

/**
 * Redaction for messages with buttons, the counterpart of
 * `RedactingChatGateway`. A prompt is never chunked, so after redaction
 * (which can lengthen text) it is fitted to one message by eliding the
 * middle, keeping the start and the end.
 */
export class RedactingPromptGateway implements PromptGateway {
  constructor(
    private readonly inner: PromptGateway,
    private readonly redactor: SecretRedactor,
    /** The platform limit for one message, in UTF-16 code units. */
    private readonly maxLength: number,
  ) {}

  sendPrompt(chatId: string, text: string, keyboard: PromptKeyboard): Promise<PromptRef> {
    return this.inner.sendPrompt(chatId, this.#clean(text), keyboard)
  }

  editPrompt(ref: PromptRef, text: string, keyboard: PromptKeyboard): Promise<void> {
    return this.inner.editPrompt(ref, this.#clean(text), keyboard)
  }

  answerCallback(callbackId: string, text?: string): Promise<void> {
    return this.inner.answerCallback(callbackId, text === undefined ? undefined : this.#clean(text))
  }

  #clean(text: string): string {
    return elideMiddle(this.redactor.redact(text).text, this.maxLength)
  }
}
