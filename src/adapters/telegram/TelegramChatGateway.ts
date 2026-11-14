import { Api, GrammyError } from 'grammy'
import type { ChatGateway, SendOptions, SendReceipt } from '../../application/ports/ChatGateway.ts'
import type { Sleeper } from '../../application/ports/Sleeper.ts'
import { TimerSleeper } from '../system/TimerSleeper.ts'
import { describeTelegramError, TelegramCallError } from './redact.ts'

/**
 * Bot API 10.4, `sendMessage`: "Text of the message to be sent, 1-4096
 * characters after entities parsing". Telegram counts message text and
 * entity offsets in UTF-16 code units (core.telegram.org/api/entities), which
 * is JavaScript's string length. Splitting by code units also keeps every
 * chunk within 4096 code points, so it is safe under either reading.
 */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096

const SEND_TIMEOUT_SECONDS = 30
/** 429 Too Many Requests: retry at most this many times... */
const MAX_FLOOD_RETRIES = 3
/** ...and only when Telegram asks to wait no longer than this; otherwise fail now. */
const MAX_RETRY_AFTER_SECONDS = 60

export interface TelegramChatGatewayOptions {
  /** Replaces the network, for tests. */
  readonly fetch?: typeof fetch
  /** Waits out `retry_after`; tests pass a fake. */
  readonly sleeper?: Sleeper
}

/**
 * The raw Telegram adapter. Plain text only (no parse mode, so nothing in the
 * text is interpreted as markup or hidden links) and link previews disabled.
 * Only `src/composition/outbound.ts` may construct it: everything else gets
 * it wrapped in the redacting and chunking decorators.
 */
export class TelegramChatGateway implements ChatGateway {
  readonly #api: Api
  readonly #token: string
  readonly #sleeper: Sleeper

  constructor(token: string, options: TelegramChatGatewayOptions = {}) {
    this.#token = token
    this.#sleeper = options.sleeper ?? new TimerSleeper()
    this.#api = new Api(token, {
      timeoutSeconds: SEND_TIMEOUT_SECONDS,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
  }

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    const replyTo = options?.replyTo
    await this.#call(() =>
      this.#api.sendMessage(chatId, text, {
        link_preview_options: { is_disabled: true },
        ...(replyTo === undefined
          ? {}
          : {
              reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true },
            }),
      }),
    )
    return { parts: 1, redactions: 0 }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.#api.sendChatAction(chatId, 'typing')
    } catch (error) {
      throw new TelegramCallError(describeTelegramError(error, this.#token))
    }
  }

  async #call(send: () => Promise<unknown>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await send()
        return
      } catch (error) {
        const wait = floodWaitSeconds(error)
        if (wait === undefined || attempt >= MAX_FLOOD_RETRIES || wait > MAX_RETRY_AFTER_SECONDS) {
          throw new TelegramCallError(describeTelegramError(error, this.#token))
        }
        await this.#sleeper.sleep(wait * 1000)
      }
    }
  }
}

/** Seconds Telegram asks us to wait after a 429, if that is what this error is. */
function floodWaitSeconds(error: unknown): number | undefined {
  if (!(error instanceof GrammyError) || error.error_code !== 429) return undefined
  const retryAfter = error.parameters.retry_after
  return typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter : 1
}
