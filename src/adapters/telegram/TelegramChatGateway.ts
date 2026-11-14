import { Api } from 'grammy'
import type { ChatGateway } from '../../application/ports/ChatGateway.ts'
import { describeTelegramError, TelegramCallError } from './redact.ts'

const SEND_TIMEOUT_SECONDS = 30

/** Plain-text `sendMessage` (no parse mode, so nothing in the text is interpreted). */
export class TelegramChatGateway implements ChatGateway {
  readonly #api: Api
  readonly #token: string

  constructor(token: string, fetchImpl?: typeof fetch) {
    this.#token = token
    this.#api = new Api(token, {
      timeoutSeconds: SEND_TIMEOUT_SECONDS,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    })
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.#api.sendMessage(chatId, text)
    } catch (error) {
      throw new TelegramCallError(describeTelegramError(error, this.#token))
    }
  }
}
