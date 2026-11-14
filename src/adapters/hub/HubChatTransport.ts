import type { SendOptions, SendReceipt } from '../../application/ports/ChatGateway.ts'
import type { DocumentReceipt, OutboundDocument } from '../../application/ports/DocumentGateway.ts'
import type { OutboundImage } from '../../application/ports/ImageGateway.ts'
import type { PromptKeyboard } from '../../application/ports/PromptGateway.ts'
import {
  StatusFloodWaitError,
  StatusMessageGoneError,
} from '../../application/ports/StatusMessageGateway.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import { type HubClient, HubRequestError } from '../ipc/HubClient.ts'
import {
  DocumentReceiptValue,
  type HubRequest,
  PromptRefValue,
  SendReceiptValue,
} from '../ipc/hubProtocol.ts'

/** Uploads may take long on a slow link (the hub uses 120 s for them). */
const UPLOAD_TIMEOUT_MS = 150_000

/**
 * A spoke's way out (F14): the platform end of its `buildOutbound`, so
 * everything reaching it is already redacted, chunked and fitted in this
 * process. Each call is one request to the hub, which binds it to this
 * session's topic. The hub's errors come back as the ones the application
 * expects (a flood wait or a vanished status message); a hub that is not
 * reachable is `HubUnavailableError`, whose message says how to start it.
 */
export class HubChatTransport {
  constructor(private readonly client: Pick<HubClient, 'request'>) {}

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    const value = await this.#call({
      op: 'sendText',
      chatId,
      text,
      ...(options?.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    })
    SendReceiptValue.parse(value)
    // The hub's own receipt counts its redactions (none: this side redacted first).
    return { parts: 1, redactions: 0 }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.#call({ op: 'typing', chatId })
  }

  async sendPrompt(chatId: string, text: string, keyboard: PromptKeyboard): Promise<PromptRef> {
    return PromptRefValue.parse(
      await this.#call({ op: 'sendPrompt', chatId, text, keyboard: plain(keyboard) }),
    )
  }

  async editPrompt(ref: PromptRef, text: string, keyboard: PromptKeyboard): Promise<void> {
    await this.#call({ op: 'editPrompt', ref, text, keyboard: plain(keyboard) })
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.#call({ op: 'answerCallback', callbackId, ...(text === undefined ? {} : { text }) })
  }

  async sendImage(chatId: string, image: OutboundImage, caption: string): Promise<void> {
    await this.#call(
      {
        op: 'sendImage',
        chatId,
        image: { path: image.path, filename: image.filename, as: image.as },
        caption,
      },
      UPLOAD_TIMEOUT_MS,
    )
  }

  async sendDocument(
    chatId: string,
    document: OutboundDocument,
    caption: string,
  ): Promise<DocumentReceipt> {
    const value = await this.#call(
      {
        op: 'sendDocument',
        chatId,
        document: {
          filename: document.filename,
          text: document.text,
          maxBytes: document.maxBytes,
          cutNote: document.cutNote,
        },
        caption,
      },
      UPLOAD_TIMEOUT_MS,
    )
    return DocumentReceiptValue.parse(value)
  }

  async sendStatus(chatId: string, text: string): Promise<PromptRef> {
    return PromptRefValue.parse(await this.#call({ op: 'sendStatus', chatId, text }))
  }

  async editStatus(ref: PromptRef, text: string): Promise<void> {
    await this.#call({ op: 'editStatus', ref, text })
  }

  async pinStatus(ref: PromptRef): Promise<void> {
    await this.#call({ op: 'pinStatus', ref })
  }

  async unpinStatus(ref: PromptRef): Promise<void> {
    await this.#call({ op: 'unpinStatus', ref })
  }

  async #call(request: HubRequest, timeoutMs?: number): Promise<unknown> {
    try {
      return await this.client.request(request, timeoutMs)
    } catch (error) {
      if (error instanceof HubRequestError) {
        if (error.kind === 'status_flood') {
          throw new StatusFloodWaitError(error.retryAfterMs ?? 1000)
        }
        if (error.kind === 'status_gone') throw new StatusMessageGoneError()
      }
      throw error
    }
  }
}

function plain(keyboard: PromptKeyboard): { label: string; data: string }[][] {
  return keyboard.map((row) => row.map((button) => ({ label: button.label, data: button.data })))
}
