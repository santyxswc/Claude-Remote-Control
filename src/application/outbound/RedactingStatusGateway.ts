import { elideMiddle } from '../../domain/elideMiddle.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { SecretRedactor } from '../../domain/redaction/SecretRedactor.ts'
import type { StatusMessageGateway } from '../ports/StatusMessageGateway.ts'

/** The pinned status (F9): redacted, then fitted to one message. */
export class RedactingStatusGateway implements StatusMessageGateway {
  constructor(
    private readonly inner: StatusMessageGateway,
    private readonly redactor: SecretRedactor,
    private readonly maxLength: number,
  ) {}

  sendStatus(chatId: string, text: string): Promise<PromptRef> {
    return this.inner.sendStatus(chatId, this.#fit(text))
  }

  editStatus(ref: PromptRef, text: string): Promise<void> {
    return this.inner.editStatus(ref, this.#fit(text))
  }

  pinStatus(ref: PromptRef): Promise<void> {
    return this.inner.pinStatus(ref)
  }

  unpinStatus(ref: PromptRef): Promise<void> {
    return this.inner.unpinStatus(ref)
  }

  #fit(text: string): string {
    return elideMiddle(this.redactor.redact(text).text, this.maxLength)
  }
}
