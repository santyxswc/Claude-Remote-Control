/**
 * The outbound pipeline (GoF Decorator):
 *
 *   text:    RedactingChatGateway (fits one message on request) -> ChunkingChatGateway -> route
 *   prompts: RedactingPromptGateway (fits one message, after redaction) -> route -> Telegram
 *   images:  RedactingImageGateway (caption redacted and fitted) -> route -> Telegram
 *   docs:    RedactingDocumentGateway (content redacted, then cut between lines; caption fitted) -> route -> Telegram
 *   status:  RedactingStatusGateway (redacted, then fitted to one message) -> route -> Telegram
 *   charts:  RedactingChartRenderer (every string in the spec redacted) -> chart renderer
 *            (the PNG it draws then goes out through the image pipeline above)
 *   topics:  RedactingTopicGateway (name redacted and fitted) -> Telegram (F14, the hub only)
 *
 * In hub mode (F14) a session's channel is a spoke: its 	ransport is the
 * IPC proxy to the hub instead of Telegram, so its text is redacted and
 * chunked here, in the spoke, before it leaves the process. The hub runs
 * uildOutbound too, with the token: the raw gateway exists only there,
 * behind the same decorators, and is never reachable by a spoke.
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
import { RedactingChartRenderer } from '../application/outbound/RedactingChartRenderer.ts'
import { RedactingChatGateway } from '../application/outbound/RedactingChatGateway.ts'
import { RedactingDocumentGateway } from '../application/outbound/RedactingDocumentGateway.ts'
import { RedactingImageGateway } from '../application/outbound/RedactingImageGateway.ts'
import { RedactingPromptGateway } from '../application/outbound/RedactingPromptGateway.ts'
import { RedactingStatusGateway } from '../application/outbound/RedactingStatusGateway.ts'
import { RedactingTopicGateway } from '../application/outbound/RedactingTopicGateway.ts'
import type { ChartRenderer, RenderedChart } from '../application/ports/ChartRenderer.ts'
import type { ChatGateway, SendOptions, SendReceipt } from '../application/ports/ChatGateway.ts'
import type {
  DocumentGateway,
  DocumentReceipt,
  OutboundDocument,
} from '../application/ports/DocumentGateway.ts'
import type { ForumTopicGateway } from '../application/ports/ForumTopicGateway.ts'
import type { ImageGateway, OutboundImage } from '../application/ports/ImageGateway.ts'
import type {
  PromptGateway,
  PromptKeyboard,
  PromptOptions,
} from '../application/ports/PromptGateway.ts'
import type { CaptureWorkspace } from '../application/ports/ScreenCapturer.ts'
import type { Sleeper } from '../application/ports/Sleeper.ts'
import type { StatusMessageGateway } from '../application/ports/StatusMessageGateway.ts'
import type { JsonObject } from '../domain/charts/chartSpec.ts'
import type { PromptRef } from '../domain/permissions/PermissionRequest.ts'
import { createSecretRedactor } from '../domain/redaction/secretValues.ts'

export interface OutboundOptions {
  /** The bot token; without it only the dev chat can be reached. Always redacted. */
  readonly token: string | undefined
  /** The dev listener's gateway, when `TELEGRAM_BRIDGE_DEV_PORT` is set. */
  readonly dev: DevChatGateway | undefined
  /** Literal values to redact verbatim (from the project's env files). */
  readonly literalSecrets: readonly string[]
  /**
   * Draws charts (F11). Text drawn into pixels cannot be redacted afterwards,
   * so the renderer is wrapped here: it only ever sees a redacted spec.
   */
  readonly charts?: ChartRenderer
  /**
   * F14, a spoke: where decorated content goes instead of Telegram (the IPC
   * proxy to the hub). The token, if given, is still redacted.
   */
  readonly transport?: OutboundTransport
  /** Test seams for the Telegram adapter. */
  readonly fetch?: typeof fetch
  readonly sleeper?: Sleeper
}

/** What a platform (Telegram, or the hub proxy of a spoke) offers the decorators. */
export type OutboundTransport = ChatGateway &
  PromptGateway &
  ImageGateway &
  DocumentGateway &
  StatusMessageGateway

export type Outbound = ChatGateway &
  PromptGateway &
  ImageGateway &
  DocumentGateway &
  StatusMessageGateway &
  ChartRenderer &
  ForumTopicGateway

export function buildOutbound(options: OutboundOptions): Outbound {
  const raw =
    options.transport !== undefined || options.token === undefined
      ? undefined
      : new TelegramChatGateway(options.token, {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.sleeper === undefined ? {} : { sleeper: options.sleeper }),
        })
  const telegram: OutboundTransport | undefined = options.transport ?? raw
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
      TELEGRAM_MAX_MESSAGE_LENGTH,
    ),
    new RedactingPromptGateway(routed, redactor, TELEGRAM_MAX_MESSAGE_LENGTH),
    new RedactingImageGateway(routed, redactor, TELEGRAM_MAX_CAPTION_LENGTH),
    new RedactingDocumentGateway(routed, redactor, TELEGRAM_MAX_CAPTION_LENGTH),
    new RedactingStatusGateway(routed, redactor, TELEGRAM_MAX_MESSAGE_LENGTH),
    options.charts === undefined ? undefined : new RedactingChartRenderer(options.charts, redactor),
    raw === undefined ? undefined : new RedactingTopicGateway(raw, redactor),
  )
}

/** One object for the decorated pipelines, so callers need a single gateway. */
class OutboundGateway
  implements
    ChatGateway,
    PromptGateway,
    ImageGateway,
    DocumentGateway,
    StatusMessageGateway,
    ChartRenderer,
    ForumTopicGateway
{
  constructor(
    private readonly chat: ChatGateway,
    private readonly prompts: PromptGateway,
    private readonly images: ImageGateway,
    private readonly documents: DocumentGateway,
    private readonly status: StatusMessageGateway,
    private readonly charts: ChartRenderer | undefined,
    private readonly topics: ForumTopicGateway | undefined,
  ) {}

  async createTopic(chatId: string, name: string): Promise<string> {
    if (this.topics === undefined) throw new Error('forum topics need the bot token (the hub)')
    return this.topics.createTopic(chatId, name)
  }

  async renderChart(
    spec: JsonObject,
    workspace: CaptureWorkspace,
    signal?: AbortSignal,
  ): Promise<RenderedChart> {
    if (this.charts === undefined) throw new Error('no chart renderer is configured')
    return this.charts.renderChart(spec, workspace, signal)
  }

  sendDocument(
    chatId: string,
    document: OutboundDocument,
    caption: string,
  ): Promise<DocumentReceipt> {
    return this.documents.sendDocument(chatId, document, caption)
  }

  sendStatus(chatId: string, text: string): Promise<PromptRef> {
    return this.status.sendStatus(chatId, text)
  }

  editStatus(ref: PromptRef, text: string): Promise<void> {
    return this.status.editStatus(ref, text)
  }

  pinStatus(ref: PromptRef): Promise<void> {
    return this.status.pinStatus(ref)
  }

  unpinStatus(ref: PromptRef): Promise<void> {
    return this.status.unpinStatus(ref)
  }

  sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    return this.chat.sendText(chatId, text, options)
  }

  sendTyping(chatId: string): Promise<void> {
    return this.chat.sendTyping(chatId)
  }

  sendPrompt(
    chatId: string,
    text: string,
    keyboard: PromptKeyboard,
    options?: PromptOptions,
  ): Promise<PromptRef> {
    return this.prompts.sendPrompt(chatId, text, keyboard, options)
  }

  editPrompt(
    ref: PromptRef,
    text: string,
    keyboard: PromptKeyboard,
    options?: PromptOptions,
  ): Promise<void> {
    return this.prompts.editPrompt(ref, text, keyboard, options)
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
 * Telegram. Prompts (buttons), images, documents and the pinned status exist
 * only on Telegram.
 */
class RoutingGateway
  implements ChatGateway, PromptGateway, ImageGateway, DocumentGateway, StatusMessageGateway
{
  constructor(
    private readonly telegram: OutboundTransport | undefined,
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

  async sendDocument(
    chatId: string,
    document: OutboundDocument,
    caption: string,
  ): Promise<DocumentReceipt> {
    return this.#telegram().sendDocument(chatId, document, caption)
  }

  async sendStatus(chatId: string, text: string): Promise<PromptRef> {
    return this.#telegram().sendStatus(chatId, text)
  }

  async editStatus(ref: PromptRef, text: string): Promise<void> {
    return this.#telegram().editStatus(ref, text)
  }

  async pinStatus(ref: PromptRef): Promise<void> {
    return this.#telegram().pinStatus(ref)
  }

  async unpinStatus(ref: PromptRef): Promise<void> {
    return this.#telegram().unpinStatus(ref)
  }

  #target(chatId: string): ChatGateway {
    if (chatId === DEV_CHAT_ID && this.dev !== undefined) return this.dev
    return this.#telegram()
  }

  #telegram(): OutboundTransport {
    if (this.telegram !== undefined) return this.telegram
    throw new Error(
      'no chat platform is configured for this chat; run `bun run bridge -- init`, or use the dev listener',
    )
  }
}
