import { topicTarget } from '../../domain/hub/conversationTarget.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { ChatGateway, SendOptions, SendReceipt } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type {
  DocumentGateway,
  DocumentReceipt,
  OutboundDocument,
} from '../ports/DocumentGateway.ts'
import { TopicGoneError } from '../ports/ForumTopicGateway.ts'
import type { HubMessageLedger } from '../ports/HubMessageLedger.ts'
import type { ImageGateway, OutboundImage } from '../ports/ImageGateway.ts'
import type { PromptGateway, PromptKeyboard } from '../ports/PromptGateway.ts'
import type { StatusMessageGateway } from '../ports/StatusMessageGateway.ts'
import type { AuthorizeSender } from '../use-cases/AuthorizeSender.ts'
import type { LiveSession } from './HubRegistry.ts'

/** A spoke asked for something outside its own topic; nothing was sent. */
export class SpokeRequestRefusedError extends Error {
  constructor(reason: string) {
    super(`refused by the hub: ${reason}`)
    this.name = 'SpokeRequestRefusedError'
  }
}

export interface DownloadedFile {
  /** A private file in the state directory; the spoke takes it over. */
  readonly path: string
  readonly size: number
}

export interface TopicBoundGatewayDeps {
  /** The hub's group. */
  readonly chatId: string
  readonly session: LiveSession
  /** The hub's decorated gateway from `buildOutbound` (redaction again, with the token). */
  readonly outbound: ChatGateway &
    PromptGateway &
    ImageGateway &
    DocumentGateway &
    StatusMessageGateway
  readonly authorize: AuthorizeSender
  readonly ledger: HubMessageLedger
  /** Only images the spoke wrote in the state directory's scratch area (checked by the adapter). */
  readonly isLocalImage: (path: string) => boolean
  readonly download: (fileId: string, maxBytes: number) => Promise<DownloadedFile>
  /** The topic was deleted in Telegram: recreate it; the new id, if that worked. */
  readonly recreateTopic: (topicId: string) => Promise<string | undefined>
  readonly clock: Clock
}

/**
 * Everything a spoke may send, bound to its own topic (F14, invariant 4).
 * The spoke names "the chat" as its owner's id (it sees its topic as a
 * private chat); the hub checks that id against the live allowlist, then
 * stamps the group and the session's thread id itself. Nothing the spoke
 * sends can name another topic or chat. Edits and pins are accepted only for
 * messages the ledger says were sent to this topic; a tap can be answered
 * only if it was routed to this session; a file downloaded only if it came
 * in a message routed to this session.
 */
export class TopicBoundGateway
  implements ChatGateway, PromptGateway, ImageGateway, DocumentGateway, StatusMessageGateway
{
  constructor(private readonly deps: TopicBoundGatewayDeps) {}

  async sendText(chatId: string, text: string, options?: SendOptions): Promise<SendReceipt> {
    this.#owner(chatId)
    return this.#inTopic((target) =>
      this.deps.outbound.sendText(
        target,
        text,
        options?.replyTo === undefined ? undefined : { replyTo: options.replyTo },
      ),
    )
  }

  async sendTyping(chatId: string): Promise<void> {
    this.#owner(chatId)
    await this.#inTopic((target) => this.deps.outbound.sendTyping(target))
  }

  async sendPrompt(chatId: string, text: string, keyboard: PromptKeyboard): Promise<PromptRef> {
    this.#owner(chatId)
    const ref = await this.#inTopic((target) =>
      this.deps.outbound.sendPrompt(target, text, keyboard),
    )
    return this.#own(chatId, ref)
  }

  async editPrompt(ref: PromptRef, text: string, keyboard: PromptKeyboard): Promise<void> {
    await this.deps.outbound.editPrompt(this.#ownedRef(ref), text, keyboard)
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    if (!this.deps.session.routedCallbacks.has(callbackId)) {
      throw new SpokeRequestRefusedError('the tap was not routed to this session')
    }
    this.deps.session.routedCallbacks.delete(callbackId)
    await this.deps.outbound.answerCallback(callbackId, text)
  }

  async sendImage(chatId: string, image: OutboundImage, caption: string): Promise<void> {
    this.#owner(chatId)
    if (!this.deps.isLocalImage(image.path)) {
      throw new SpokeRequestRefusedError('the image is not in the scratch directory')
    }
    await this.#inTopic((target) => this.deps.outbound.sendImage(target, image, caption))
  }

  async sendDocument(
    chatId: string,
    document: OutboundDocument,
    caption: string,
  ): Promise<DocumentReceipt> {
    this.#owner(chatId)
    return this.#inTopic((target) => this.deps.outbound.sendDocument(target, document, caption))
  }

  async sendStatus(chatId: string, text: string): Promise<PromptRef> {
    this.#owner(chatId)
    const ref = await this.#inTopic((target) => this.deps.outbound.sendStatus(target, text))
    return this.#own(chatId, ref)
  }

  async editStatus(ref: PromptRef, text: string): Promise<void> {
    await this.deps.outbound.editStatus(this.#ownedRef(ref), text)
  }

  async pinStatus(ref: PromptRef): Promise<void> {
    await this.deps.outbound.pinStatus(this.#ownedRef(ref))
  }

  async unpinStatus(ref: PromptRef): Promise<void> {
    await this.deps.outbound.unpinStatus(this.#ownedRef(ref))
  }

  download(fileId: string, maxBytes: number): Promise<DownloadedFile> {
    if (!this.deps.session.routedFiles.has(fileId)) {
      return Promise.reject(new SpokeRequestRefusedError('the file was not sent to this session'))
    }
    return this.deps.download(fileId, maxBytes)
  }

  /** The spoke's "chat" must be an allowlisted owner (checked on every call, like `reply`). */
  #owner(chatId: string): void {
    if (!this.deps.authorize.execute(chatId)) {
      throw new SpokeRequestRefusedError('the chat is not an allowlisted owner')
    }
  }

  /** A message of this session's topic, addressed in the group; the spoke never names the group. */
  #ownedRef(ref: PromptRef): PromptRef {
    this.#owner(ref.chatId)
    const topic = this.deps.ledger.topicOf(this.deps.chatId, ref.messageId)
    if (topic === undefined || topic !== this.deps.session.topicId) {
      throw new SpokeRequestRefusedError('the message is not in this session topic')
    }
    return { chatId: topicTarget(this.deps.chatId, topic), messageId: ref.messageId }
  }

  #own(chatId: string, ref: PromptRef): PromptRef {
    const topic = this.deps.session.topicId
    this.deps.ledger.record(this.deps.chatId, ref.messageId, topic, this.deps.clock.now())
    return { chatId, messageId: ref.messageId }
  }

  /** Sends to the topic; once, if it turns out deleted, to a recreated one. */
  async #inTopic<T>(send: (target: string) => Promise<T>): Promise<T> {
    const session = this.deps.session
    try {
      return await send(topicTarget(this.deps.chatId, session.topicId))
    } catch (error) {
      if (!(error instanceof TopicGoneError)) throw error
      const fresh = await this.deps.recreateTopic(session.topicId)
      if (fresh === undefined) throw error
      session.topicId = fresh
      return send(topicTarget(this.deps.chatId, fresh))
    }
  }
}
