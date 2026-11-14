/**
 * The outbound pipeline (GoF Decorator):
 *
 *   text:    RedactingChatGateway -> ChunkingChatGateway -> route -> Telegram | Dev
 *   prompts: RedactingPromptGateway (fits one message) -> route -> Telegram
 *   images:  RedactingImageGateway (caption redacted and fitted) -> route -> Telegram
 *
 * This module is the only place that constructs the raw platform gateway,
 * and `buildOutbound` is its only export, so nothing in the app can get hold
 * of a gateway that skips redaction. `tests/composition/outbound.test.ts`
 * enforces both.
 */
import type { DevChatGateway } from '../adapters/dev/DevChatGateway.ts'
import { DEV_CHAT_ID } from '../adapters/dev/DevHttpInbound.ts'
import {
  TELEGRAM_MAX_CAPTION_LENGTH,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TelegramChatGateway,
} from '../adapters/telegram/TelegramChatGateway.ts'
import { ChunkingChatGateway } from '../application/outbound/ChunkingChatGateway.ts'
import { RedactingChatGateway } from '../application/outbound/RedactingChatGateway.ts'
import { RedactingImageGateway } from '../application/outbound/RedactingImageGateway.ts'
import { RedactingPromptGateway } from '../application/outbound/RedactingPromptGateway.ts'
import type { ChatGateway, SendOptions, SendReceipt } from '../application/ports/ChatGateway.ts'
import type { ImageGateway, OutboundImage } from '../application/ports/ImageGateway.ts'
import type { PromptGateway, PromptKeyboard } from '../application/ports/PromptGateway.ts'
import type { Sleeper } from '../application/ports/Sleeper.ts'
import type { PromptRef } from '../domain/permissions/PermissionRequest.ts'
import { createSecretRedactor } from '../domain/redaction/secretValues.ts'

export interface OutboundOptions {
  /** The bot token; without it only the dev chat can be reached. Always redacted. */
  readonly token: string | undefined
  /** The dev listener's gateway, when `TELEGRAM_BRIDGE_DEV_PORT` is set. */
  readonly dev: DevChatGateway | undefined
  /** Literal values to redact verbatim (from the project's env files). */
  readonly literalSecrets: readonly string[]
  /** Test seams for the Telegram adapter. */
  readonly fetch?: typeof fetch
  readonly sleeper?: Sleeper
}

export type Outbound = ChatGateway & PromptGateway & ImageGateway

export function buildOutbound(options: OutboundOptions): Outbound {
  const telegram =
    options.token === undefined
      ? undefined
      : new TelegramChatGateway(options.token, {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.sleeper === undefined ? {} : { sleeper: options.sleeper }),
        })
  const redactor = createSecretRedactor(
    options.token === undefined
      ? options.literalSecrets
      : [...options.literalSecrets, options.token],
  )
  const routed = new RoutingGateway(telegram, options.dev)
  return new OutboundGateway(
    new RedactingChatGateway(
      new ChunkingChatGateway(routed, TELEGRAM_MAX_MESSAGE_LENGTH),
      redactor,
    ),
    new RedactingPromptGateway(routed, redactor, TELEGRAM_MAX_MESSAGE_LENGTH),
    new RedactingImageGateway(routed, redactor, TELEGRAM_MAX_CAPTION_LENGTH),
  )
}

/** One object for the decorated pipelines, so callers need a single gateway. */
class OutboundGateway implements ChatGateway, PromptGateway, ImageGateway {
  constructor(
    private readonly chat: ChatGateway,
    private readonly prompts: PromptGateway,
    private readonly images: ImageGateway,
  ) {}

  sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    return this.chat.sendText(chatId, text, options)
  }

  sendTyping(chatId: string): Promise<void> {
    return this.chat.sendTyping(chatId)
  }

  sendPrompt(chatId: string, text: string, keyboard: PromptKeyboard): Promise<PromptRef> {
    return this.prompts.sendPrompt(chatId, text, keyboard)
  }

  editPrompt(ref: PromptRef, text: string, keyboard: PromptKeyboard): Promise<void> {
    return this.prompts.editPrompt(ref, text, keyboard)
  }

  answerCallback(callbackId: string, text?: string): Promise<void> {
    return this.prompts.answerCallback(callbackId, text)
  }

  sendImage(chatId: string, image: OutboundImage, caption: string): Promise<void> {
    return this.images.sendImage(chatId, image, caption)
  }
}

/**
 * The dev chat id goes to the dev listener; every other chat goes to
 * Telegram. Prompts (buttons) and images exist only on Telegram.
 */
class RoutingGateway implements ChatGateway, PromptGateway, ImageGateway {
  constructor(
    private readonly telegram: TelegramChatGateway | undefined,
    private readonly dev: ChatGateway | undefined,
  ) {}

  sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    return this.#target(chatId).sendText(chatId, text, options)
  }

  sendTyping(chatId: string): Promise<void> {
    return this.#target(chatId).sendTyping(chatId)
  }

  async sendPrompt(chatId: string, text: string, keyboard: PromptKeyboard): Promise<PromptRef> {
    return this.#telegram().sendPrompt(chatId, text, keyboard)
  }

  async editPrompt(ref: PromptRef, text: string, keyboard: PromptKeyboard): Promise<void> {
    return this.#telegram().editPrompt(ref, text, keyboard)
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    return this.#telegram().answerCallback(callbackId, text)
  }

  async sendImage(chatId: string, image: OutboundImage, caption: string): Promise<void> {
    return this.#telegram().sendImage(chatId, image, caption)
  }

  #target(chatId: string): ChatGateway {
    if (chatId === DEV_CHAT_ID && this.dev !== undefined) return this.dev
    return this.#telegram()
  }

  #telegram(): TelegramChatGateway {
    if (this.telegram !== undefined) return this.telegram
    throw new Error(
      'no chat platform is configured for this chat; run `bun run bridge -- init`, or use the dev listener',
    )
  }
}
