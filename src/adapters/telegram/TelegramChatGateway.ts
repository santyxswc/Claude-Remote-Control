import { Api, GrammyError, InputFile } from 'grammy'
import type { InlineKeyboardMarkup } from 'grammy/types'
import type { ChatGateway, SendOptions, SendReceipt } from '../../application/ports/ChatGateway.ts'
import type { ImageGateway, OutboundImage } from '../../application/ports/ImageGateway.ts'
import type { PromptGateway, PromptKeyboard } from '../../application/ports/PromptGateway.ts'
import type { Sleeper } from '../../application/ports/Sleeper.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
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

/** Bot API: `callback_data` of an inline button is "1-64 bytes". */
export const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64

/** Bot API: a media caption is "0-1024 characters after entities parsing". */
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024

const SEND_TIMEOUT_SECONDS = 30
/** An image upload (up to 50 MB) may need longer on a slow link. */
const UPLOAD_TIMEOUT_SECONDS = 120
/** 429 Too Many Requests: retry at most this many times... */
const MAX_FLOOD_RETRIES = 3
/** ...and only when Telegram asks to wait no longer than this; otherwise fail now. */
const MAX_RETRY_AFTER_SECONDS = 60

const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const

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
 * it wrapped in the redacting (and, for plain text, chunking) decorators.
 */
export class TelegramChatGateway implements ChatGateway, PromptGateway, ImageGateway {
  readonly #api: Api
  readonly #uploads: Api
  readonly #token: string
  readonly #sleeper: Sleeper

  constructor(token: string, options: TelegramChatGatewayOptions = {}) {
    this.#token = token
    this.#sleeper = options.sleeper ?? new TimerSleeper()
    const fetchOption = options.fetch === undefined ? {} : { fetch: options.fetch }
    this.#api = new Api(token, { timeoutSeconds: SEND_TIMEOUT_SECONDS, ...fetchOption })
    this.#uploads = new Api(token, { timeoutSeconds: UPLOAD_TIMEOUT_SECONDS, ...fetchOption })
  }

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    const replyTo = options?.replyTo
    await this.#call(() =>
      this.#api.sendMessage(chatId, text, {
        ...NO_PREVIEW,
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

  async sendPrompt(chatId: string, text: string, keyboard: PromptKeyboard): Promise<PromptRef> {
    const sent = await this.#call(() =>
      this.#api.sendMessage(chatId, text, { ...NO_PREVIEW, reply_markup: toMarkup(keyboard) }),
    )
    return { chatId, messageId: String(sent.message_id) }
  }

  /** An empty keyboard removes the buttons. Editing to identical content is not an error. */
  async editPrompt(ref: PromptRef, text: string, keyboard: PromptKeyboard): Promise<void> {
    try {
      await this.#call(() =>
        this.#api.editMessageText(ref.chatId, Number(ref.messageId), text, {
          ...NO_PREVIEW,
          reply_markup: toMarkup(keyboard),
        }),
      )
    } catch (error) {
      if (error instanceof TelegramCallError && /message is not modified/i.test(error.message)) {
        return
      }
      throw error
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.#call(() =>
      this.#api.answerCallbackQuery(callbackId, text === undefined ? {} : { text }),
    )
  }

  /** Multipart upload from the local file; a fresh `InputFile` per attempt, plain-text caption. */
  async sendImage(chatId: string, image: OutboundImage, caption: string): Promise<void> {
    const file = () => new InputFile(image.path, image.filename)
    await this.#call<unknown>(() =>
      image.as === 'photo'
        ? this.#uploads.sendPhoto(chatId, file(), { caption })
        : this.#uploads.sendDocument(chatId, file(), { caption }),
    )
  }

  async #call<T>(send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send()
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

function toMarkup(keyboard: PromptKeyboard): InlineKeyboardMarkup {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => {
        if (new TextEncoder().encode(button.data).length > TELEGRAM_MAX_CALLBACK_DATA_BYTES) {
          throw new Error('callback data is longer than Telegram allows')
        }
        return { text: button.label, callback_data: button.data }
      }),
    ),
  }
}

/** Seconds Telegram asks us to wait after a 429, if that is what this error is. */
function floodWaitSeconds(error: unknown): number | undefined {
  if (!(error instanceof GrammyError) || error.error_code !== 429) return undefined
  const retryAfter = error.parameters.retry_after
  return typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter : 1
}
