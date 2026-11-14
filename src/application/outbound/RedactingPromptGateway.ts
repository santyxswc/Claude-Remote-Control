import { ELLIPSIS, elideMiddle } from '../../domain/elideMiddle.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { SecretRedactor } from '../../domain/redaction/SecretRedactor.ts'
import { PromptTooLongError } from '../errors.ts'
import type { PromptGateway, PromptKeyboard, PromptOptions } from '../ports/PromptGateway.ts'

/**
 * Redaction for messages with buttons, the counterpart of
 * `RedactingChatGateway`. A prompt is never chunked: the whole text is
 * redacted first, and only then fitted to one message (M3), either by
 * refusing (the caller sends the details before) or by eliding the middle
 * with a note saying how much is not shown (M2).
 */
export class RedactingPromptGateway implements PromptGateway {
  constructor(
    private readonly inner: PromptGateway,
    private readonly redactor: SecretRedactor,
    /** The platform limit for one message, in UTF-16 code units. */
    private readonly maxLength: number,
  ) {}

  sendPrompt(
    chatId: string,
    text: string,
    keyboard: PromptKeyboard,
    options?: PromptOptions,
  ): Promise<PromptRef> {
    return this.inner.sendPrompt(chatId, this.#fit(text, options), keyboard)
  }

  editPrompt(
    ref: PromptRef,
    text: string,
    keyboard: PromptKeyboard,
    options?: PromptOptions,
  ): Promise<void> {
    return this.inner.editPrompt(ref, this.#fit(text, options), keyboard)
  }

  answerCallback(callbackId: string, text?: string): Promise<void> {
    return this.inner.answerCallback(
      callbackId,
      text === undefined ? undefined : this.#fit(text, undefined),
    )
  }

  #fit(text: string, options: PromptOptions | undefined): string {
    const redacted = this.redactor.redact(text).text
    if (redacted.length <= this.maxLength) return redacted
    if (options?.overflow === 'refuse') throw new PromptTooLongError(redacted.length)
    const note = options?.hiddenNote
    if (note === undefined) return elideMiddle(redacted, this.maxLength)
    // The note's own length depends on the count; reserve for the largest one.
    const room = this.maxLength - note(redacted.length).length - 2
    const elided = elideMiddle(redacted, room)
    const hidden = redacted.length - (elided.length - ELLIPSIS.length)
    return `${elided}\n\n${note(hidden)}`
  }
}
