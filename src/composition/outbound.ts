/**
 * The outbound pipeline (GoF Decorator over `ChatGateway`):
 *
 *   RedactingChatGateway -> ChunkingChatGateway -> route -> TelegramChatGateway | DevChatGateway
 *
 * This module is the only place that constructs the raw platform gateway,
 * and `buildOutbound` is its only export, so nothing in the app can get hold
 * of a gateway that skips redaction. `tests/composition/outbound.test.ts`
 * enforces both.
 */
import type { DevChatGateway } from '../adapters/dev/DevChatGateway.ts'
import { DEV_CHAT_ID } from '../adapters/dev/DevHttpInbound.ts'
import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TelegramChatGateway,
} from '../adapters/telegram/TelegramChatGateway.ts'
import { ChunkingChatGateway } from '../application/outbound/ChunkingChatGateway.ts'
import { RedactingChatGateway } from '../application/outbound/RedactingChatGateway.ts'
import type { ChatGateway, SendOptions, SendReceipt } from '../application/ports/ChatGateway.ts'
import type { Sleeper } from '../application/ports/Sleeper.ts'
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

export function buildOutbound(options: OutboundOptions): ChatGateway {
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
  const routed = new RoutingChatGateway(telegram, options.dev)
  return new RedactingChatGateway(
    new ChunkingChatGateway(routed, TELEGRAM_MAX_MESSAGE_LENGTH),
    redactor,
  )
}

/** The dev chat id goes to the dev listener; every other chat goes to Telegram. */
class RoutingChatGateway implements ChatGateway {
  constructor(
    private readonly telegram: ChatGateway | undefined,
    private readonly dev: ChatGateway | undefined,
  ) {}

  sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    return this.#target(chatId).sendText(chatId, text, options)
  }

  sendTyping(chatId: string): Promise<void> {
    return this.#target(chatId).sendTyping(chatId)
  }

  #target(chatId: string): ChatGateway {
    if (chatId === DEV_CHAT_ID && this.dev !== undefined) return this.dev
    if (this.telegram !== undefined) return this.telegram
    throw new Error(
      'no chat platform is configured for this chat; run `bun run bridge -- init`, or use the dev listener',
    )
  }
}
