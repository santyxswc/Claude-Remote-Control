import { EventThrottle } from '../../domain/EventThrottle.ts'
import { topicTarget } from '../../domain/hub/conversationTarget.ts'
import { DROPPED_LOG_WINDOW_MS } from '../../domain/inboundLimits.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { TokenBucket } from '../../domain/TokenBucket.ts'
import type { InboundCallback } from '../callbacks/InboundCallback.ts'
import { parseCommand } from '../commands/parseCommand.ts'
import type { Messages } from '../i18n/messages.ts'
import type { InboundMessage } from '../pipeline/InboundMessage.ts'
import type { InboundHandler } from '../pipeline/InboundStep.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { HubMessageLedger } from '../ports/HubMessageLedger.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PromptGateway } from '../ports/PromptGateway.ts'
import type { AuthorizeSender } from '../use-cases/AuthorizeSender.ts'
import type { EngageBrake } from '../use-cases/EngageBrake.ts'
import type { ResumeSession } from '../use-cases/ResumeSession.ts'
import type { HubRegistry, LiveSession } from './HubRegistry.ts'

/** Pointers ("this topic has no session", "use a topic") at most this often per place. */
export const HUB_POINTER_WINDOW_MS = 10 * 60_000

export interface HubRouterDeps {
  /** The bound forum supergroup. */
  readonly chatId: string
  readonly authorize: AuthorizeSender
  /** Shared with the private-chat chain: one budget per sender. */
  readonly limiter: TokenBucket
  readonly registry: HubRegistry
  readonly ledger: HubMessageLedger
  readonly engage: EngageBrake
  readonly resume: ResumeSession
  /** The hub's decorated gateway, for its own replies in a topic or the private chat. */
  readonly chat: ChatGateway & Pick<PromptGateway, 'answerCallback'>
  /** The private chat: pairing, authentication, rate limit, then `handleCommand` or a pointer. */
  readonly privateChat: InboundHandler
  readonly botUsername: string | undefined
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
}

/**
 * The hub's inbound side (F14): one bot, one group, a topic per session.
 *
 * Invariant 3, authentication: a group update is accepted only when the
 * chat is exactly the bound group AND the sender (`from`, never the chat,
 * never membership) is on the allowlist. Messages on behalf of a chat
 * (anonymous admins, channels) have no person behind them and are refused.
 * Anyone else is dropped without a word, like a stranger in a private chat.
 *
 * Invariant 4, routing: an authenticated message goes only to the session
 * that holds its topic; a tap only when the tapped message is, per the
 * ledger, one the hub sent to that same topic (the session then checks that
 * the item behind the button is its own). The General topic, unknown topics
 * and the private chat reach no session.
 *
 * `/stop` and `/resume` never reach a spoke: the hub engages or releases the
 * brake file itself, before anything is awaited, and only then tells every
 * session (each denies its own pending prompts and interrupts its turn).
 */
export class HubRouter {
  readonly #dropLog = new EventThrottle(DROPPED_LOG_WINDOW_MS)
  readonly #pointers = new EventThrottle(HUB_POINTER_WINDOW_MS)

  constructor(private readonly deps: HubRouterDeps) {}

  async handleMessage(message: InboundMessage): Promise<void> {
    if (message.chatKind === 'private') return this.deps.privateChat(message)
    const sender = this.#authenticated(message.chatId, message.sender, message.onBehalfOfChat)
    if (sender === undefined) return
    const place =
      message.threadId === undefined
        ? this.deps.chatId
        : topicTarget(this.deps.chatId, message.threadId)
    if (!(await this.#withinRate(sender, place))) return
    if (await this.handleCommand(message, sender, place)) return

    if (message.threadId === undefined) {
      return this.#pointer(place, this.deps.messages.hubUseATopic)
    }
    const live = this.deps.registry.byTopic(message.threadId)
    if (live === undefined) return this.#pointer(place, this.deps.messages.hubNoSessionHere)
    this.#deliverMessage(live, message, sender, place)
  }

  async handleCallback(callback: InboundCallback): Promise<void> {
    const sender = this.#authenticated(callback.chatId, callback.sender, undefined)
    if (sender === undefined) return
    if (!this.deps.limiter.take(sender.id, this.deps.clock.now()).allowed) {
      return this.#answer(callback.id)
    }
    const { threadId, messageId } = callback
    const topic =
      messageId === undefined ? undefined : this.deps.ledger.topicOf(this.deps.chatId, messageId)
    if (threadId === undefined || topic === undefined || topic !== threadId) {
      this.deps.logger.warn('refused a tap on a message the hub did not send to that topic', {
        senderId: sender.id,
      })
      return this.#answer(callback.id, this.deps.messages.hubTapRefused)
    }
    const live = this.deps.registry.byTopic(threadId)
    if (live === undefined) return this.#answer(callback.id, this.deps.messages.hubNoSessionHere)
    live.routedCallbacks.add(callback.id)
    const delivered = live.channel.deliver({
      kind: 'tap',
      callback: {
        id: callback.id,
        chatId: sender.id,
        chatKind: 'private',
        ...(messageId === undefined ? {} : { messageId }),
        sender,
        data: callback.data,
      },
    })
    if (!delivered) {
      live.routedCallbacks.delete(callback.id)
      await this.#answer(callback.id, this.deps.messages.hubSessionBusy)
    }
  }

  /**
   * The hub's own commands, in a topic, the General topic or the private
   * chat: `/stop`, `/resume`, `/sessions`. True when handled. `place` is
   * where the reply goes.
   */
  async handleCommand(
    message: InboundMessage,
    sender: SenderProfile,
    place: string,
  ): Promise<boolean> {
    const parsed = message.text === undefined ? undefined : parseCommand(message.text)
    if (parsed === undefined || !this.#addressedToUs(parsed.mention)) return false
    const { messages } = this.deps
    switch (parsed.name.toLowerCase()) {
      case 'stop': {
        const engaged = this.deps.engage.execute({
          actor: `telegram:${sender.id}`,
          ...(parsed.args === '' ? {} : { reason: parsed.args }),
        })
        let notified = 0
        for (const live of this.deps.registry.all()) {
          if (live.channel.deliver({ kind: 'brake', sender })) notified += 1
        }
        this.deps.logger.warn('the hub engaged the brake', { notified })
        await this.#reply(place, messages.hubStopped(engaged.outcome, notified))
        return true
      }
      case 'resume': {
        const outcome = this.deps.resume.execute(`telegram:${sender.id}`)
        await this.#reply(
          place,
          outcome === 'released' ? messages.resumeReleased : messages.resumeNotEngaged,
        )
        return true
      }
      case 'sessions': {
        const live = this.deps.registry.all().map((session) => ({
          topic: session.topicName,
          project: session.projectName,
        }))
        await this.#reply(place, messages.hubSessionsList(live))
        return true
      }
      default:
        return false
    }
  }

  /** The group, the allowlisted sender, a person: else undefined (and a throttled log line). */
  #authenticated(
    chatId: string | undefined,
    sender: SenderProfile | undefined,
    onBehalfOfChat: true | undefined,
  ): SenderProfile | undefined {
    const ok =
      chatId === this.deps.chatId &&
      onBehalfOfChat !== true &&
      sender !== undefined &&
      this.deps.authorize.execute(sender.id)
    if (ok) return sender
    const reason =
      chatId !== this.deps.chatId
        ? 'not_the_hub_group'
        : onBehalfOfChat === true
          ? 'on_behalf_of_a_chat'
          : 'unauthorized_sender'
    const key = `${reason}:${sender?.id ?? `chat:${chatId}`}`
    const decision = this.#dropLog.record(key, this.deps.clock.now())
    if (decision.emit) {
      this.deps.logger.info('hub dropped an update', {
        reason,
        senderId: sender?.id ?? null,
        ...(decision.suppressed > 0 ? { suppressed: decision.suppressed } : {}),
      })
    }
    return undefined
  }

  async #withinRate(sender: SenderProfile, place: string): Promise<boolean> {
    const decision = this.deps.limiter.take(sender.id, this.deps.clock.now())
    if (decision.allowed) return true
    if (decision.notify) await this.#reply(place, this.deps.messages.slowDown)
    return false
  }

  /** Only what the spoke's chain needs, in the shape it has always seen: a private chat. */
  #deliverMessage(
    live: LiveSession,
    message: InboundMessage,
    sender: SenderProfile,
    place: string,
  ): void {
    if (message.attachment?.kind === 'photo') {
      for (const size of message.attachment.sizes) live.routedFiles.add(size.fileId)
    } else if (message.attachment?.kind === 'document') {
      live.routedFiles.add(message.attachment.fileId)
    }
    if (message.voice !== undefined) live.routedFiles.add(message.voice.fileId)
    const delivered = live.channel.deliver({
      kind: 'message',
      message: {
        chatId: sender.id,
        messageId: message.messageId,
        chatKind: 'private',
        sender,
        text: message.text,
        sentAt: message.sentAt,
        ...(message.attachment === undefined ? {} : { attachment: message.attachment }),
        ...(message.caption === undefined ? {} : { caption: message.caption }),
        ...(message.mediaGroupId === undefined ? {} : { mediaGroupId: message.mediaGroupId }),
        ...(message.voice === undefined ? {} : { voice: message.voice }),
      },
    })
    if (!delivered) void this.#pointer(place, this.deps.messages.hubSessionBusy)
  }

  async #pointer(place: string, text: string): Promise<void> {
    if (!this.#pointers.record(`${place}:${text}`, this.deps.clock.now()).emit) return
    await this.#reply(place, text)
  }

  async #reply(place: string, text: string): Promise<void> {
    try {
      await this.deps.chat.sendText(place, text)
    } catch (error) {
      this.deps.logger.warn('the hub could not reply', { error })
    }
  }

  async #answer(callbackId: string, text?: string): Promise<void> {
    try {
      await this.deps.chat.answerCallback(callbackId, text)
    } catch (error) {
      this.deps.logger.warn('the hub could not answer a tap', { error })
    }
  }

  #addressedToUs(mention: string | undefined): boolean {
    if (mention === undefined || this.deps.botUsername === undefined) return true
    return mention.toLowerCase() === this.deps.botUsername.toLowerCase()
  }
}
