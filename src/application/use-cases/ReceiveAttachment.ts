import {
  ALLOWED_EXTENSIONS,
  type AllowedType,
  type AttachmentRefusal,
  checkDeclaredSize,
  checkHead,
  choosePhotoSize,
  PHOTO_TYPE,
  SNIFF_BYTES,
  sanitizeAttachmentName,
  sniff,
  TextContentCheck,
  typeForName,
} from '../../domain/attachments/attachmentPolicy.ts'
import { EventThrottle } from '../../domain/EventThrottle.ts'
import {
  ATTACHMENT_BURST,
  ATTACHMENT_NOTICE_WINDOW_MS,
  ATTACHMENT_REFILL_MS,
  MAX_DOWNLOADS_IN_FLIGHT,
} from '../../domain/inboundLimits.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import { TokenBucket } from '../../domain/TokenBucket.ts'
import type { Messages } from '../i18n/messages.ts'
import type { InboundAttachment, InboundMessage } from '../pipeline/InboundMessage.ts'
import type { AttachmentInbox, InboxDraft } from '../ports/AttachmentInbox.ts'
import type { AttachmentSource } from '../ports/AttachmentSource.ts'
import type { AuditDetails, AuditLog } from '../ports/AuditLog.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { HandleInboundMessage } from './HandleInboundMessage.ts'

/** An authenticated message carrying a photo or a file. */
export interface AttachmentMessage extends InboundMessage {
  readonly sender: SenderProfile
  readonly attachment: InboundAttachment
}

export interface ReceiveAttachmentDeps {
  readonly source: AttachmentSource
  readonly inbox: AttachmentInbox
  /** The same delivery as typed text: typing status, "queued" note, audit. */
  readonly forward: Pick<HandleInboundMessage, 'execute'>
  /** The decorated outbound gateway, for refusal notices. */
  readonly chat: ChatGateway
  readonly messages: Pick<Messages, 'attachmentRefused'>
  /** At most this many bytes per file (Bot API limit or lower). */
  readonly maxBytes: number
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  /** Runs after a file is kept (retention and quota). */
  readonly afterKeep?: () => Promise<void>
  /** Per-sender budget of files; tests pass a tighter one. */
  readonly budget?: TokenBucket
  readonly maxInFlight?: number
}

type Plan = {
  readonly fileId: string
  readonly type: AllowedType
  readonly declared: number | undefined
  readonly name: string
}

/** A refusal decided while downloading; the partial file is discarded. */
class Refused extends Error {
  constructor(
    readonly reason: AttachmentRefusal,
    readonly sniffed?: string,
  ) {
    super(reason)
  }
}

const DEFAULT_TEXT = { photo: 'The user sent a photo.', document: 'The user sent a file.' }

/**
 * An incoming photo or file (F10). Checked before downloading (allowlisted
 * extension, declared size, per-sender budget), then streamed into this
 * session's private inbox under a name we generate, with the size cap and
 * the content checks (magic bytes, or UTF-8 text without NUL) enforced while
 * it streams: the declared size is never trusted. Only a file that passed
 * everything is kept and handed to the session as its path; anything else
 * leaves nothing on disk. At most `maxInFlight` downloads run at a time; the
 * rest wait. Downloads run in the background (`start` returns at once) and
 * `stop` cancels them. Audit rows carry the sender, size, type and reason,
 * never the file name or the caption.
 */
export class ReceiveAttachment {
  readonly #budget: TokenBucket
  readonly #notices = new EventThrottle(ATTACHMENT_NOTICE_WINDOW_MS)
  readonly #queue: AttachmentMessage[] = []
  readonly #running = new Set<Promise<void>>()
  readonly #abort = new AbortController()

  constructor(private readonly deps: ReceiveAttachmentDeps) {
    this.#budget =
      deps.budget ??
      new TokenBucket({
        burst: ATTACHMENT_BURST,
        refillMs: ATTACHMENT_REFILL_MS,
        noticeWindowMs: ATTACHMENT_NOTICE_WINDOW_MS,
      })
  }

  /** Queues the download and returns; refusals and the result are reported in the chat. */
  start(message: AttachmentMessage): void {
    if (this.#abort.signal.aborted) return
    if (!this.#budget.take(message.sender.id, this.deps.clock.now()).allowed) {
      void this.#refuse(message, new Refused('rate_limited'), undefined)
      return
    }
    this.#queue.push(message)
    this.#pump()
  }

  /**
   * For shutdown: cancels every download (running ones remove their partial
   * file), drops the queue and accepts nothing more.
   */
  async stop(): Promise<void> {
    this.#queue.length = 0
    this.#abort.abort()
    await Promise.all([...this.#running])
  }

  /** Downloads running or waiting, for tests and diagnostics. */
  get pending(): number {
    return this.#running.size + this.#queue.length
  }

  #pump(): void {
    const limit = this.deps.maxInFlight ?? MAX_DOWNLOADS_IN_FLIGHT
    while (this.#running.size < limit) {
      const next = this.#queue.shift()
      if (next === undefined) return
      const run: Promise<void> = this.#receive(next, this.#abort.signal).finally(() => {
        this.#running.delete(run)
        this.#pump()
      })
      this.#running.add(run)
    }
  }

  async #receive(message: AttachmentMessage, signal: AbortSignal): Promise<void> {
    let size: number | undefined
    try {
      const plan = this.#plan(message.attachment)
      size = plan.declared
      const kept = await this.#download(plan, signal)
      size = kept.bytes
      await this.#deliver(message, plan, kept)
    } catch (error) {
      if (signal.aborted) {
        this.deps.logger.info('download cancelled')
        return
      }
      if (!(error instanceof Refused)) {
        this.deps.logger.warn('could not download an attachment', { error })
      }
      const refused = error instanceof Refused ? error : new Refused('download_failed')
      await this.#refuse(message, refused, size)
    }
  }

  /** What to fetch and as which type, from what the platform declares. */
  #plan(attachment: InboundAttachment): Plan {
    const { maxBytes } = this.deps
    if (attachment.kind === 'photo') {
      const size = choosePhotoSize(attachment.sizes, maxBytes)
      if (size === undefined) throw new Refused('too_large')
      return { fileId: size.fileId, type: PHOTO_TYPE, declared: size.size, name: 'photo.jpg' }
    }
    const type = typeForName(attachment.fileName)
    if (type === undefined) throw new Refused('type_not_allowed')
    const declared = checkDeclaredSize(attachment.size, maxBytes)
    if (declared !== undefined) throw new Refused(declared)
    return {
      fileId: attachment.fileId,
      type,
      declared: attachment.size,
      name: sanitizeAttachmentName(attachment.fileName),
    }
  }

  async #download(
    plan: Plan,
    signal: AbortSignal,
  ): Promise<{ path: string; bytes: number; sniffed: string }> {
    const { maxBytes } = this.deps
    const remote = await this.deps.source.open(plan.fileId, signal)
    const declared = checkDeclaredSize(remote.size, maxBytes)
    if (declared !== undefined) throw new Refused(declared)

    const draft: InboxDraft = await this.deps.inbox.draft(plan.type.extension)
    const text = plan.type.kind === 'text' ? new TextContentCheck() : undefined
    let bytes = 0
    let head: Uint8Array = new Uint8Array(0)
    let headChecked = false
    const checkTheHead = () => {
      headChecked = true
      const problem = checkHead(plan.type, head)
      if (problem !== undefined) throw new Refused(problem, sniff(head) ?? 'unknown')
    }
    try {
      for await (const chunk of remote.chunks) {
        if (signal.aborted) throw new Error('cancelled')
        bytes += chunk.length
        if (bytes > maxBytes) throw new Refused('too_large')
        if (!headChecked) {
          head = concat(head, chunk.subarray(0, SNIFF_BYTES - head.length))
          if (head.length >= SNIFF_BYTES) checkTheHead()
        }
        if (text !== undefined && !text.push(chunk)) throw new Refused('type_mismatch', 'binary')
        await draft.write(chunk)
      }
      if (bytes === 0) throw new Refused('empty')
      if (!headChecked) checkTheHead()
      if (text !== undefined && !text.finish()) throw new Refused('type_mismatch', 'binary')
      const path = await draft.keep()
      return { path, bytes, sniffed: sniff(head) ?? 'text' }
    } catch (error) {
      await draft.discard()
      throw error
    }
  }

  async #deliver(
    message: AttachmentMessage,
    plan: Plan,
    kept: { path: string; bytes: number; sniffed: string },
  ): Promise<void> {
    const caption = message.caption?.trim()
    const lead =
      caption === undefined || caption === '' ? DEFAULT_TEXT[message.attachment.kind] : caption
    this.#audit('attachment.received', message, {
      size: kept.bytes,
      type: plan.type.extension,
      sniffed: kept.sniffed,
    })
    this.deps.logger.info('received an attachment', {
      senderId: message.sender.id,
      bytes: kept.bytes,
      type: plan.type.extension,
    })
    await this.deps.forward.execute({
      ...message,
      text: `${lead}\n\nAttachment saved at: ${kept.path}`,
      forwardContext: {
        kind: 'attachment',
        path: kept.path,
        name: plan.name,
        mime: plan.type.mime,
        size: kept.bytes,
      },
    })
    try {
      await this.deps.afterKeep?.()
    } catch (error) {
      this.deps.logger.warn('inbox upkeep failed', { error })
    }
  }

  /** Audited every time; the chat is told once per album (or file) per window. */
  async #refuse(
    message: AttachmentMessage,
    refused: Refused,
    size: number | undefined,
  ): Promise<void> {
    this.#audit('attachment.refused', message, {
      reason: refused.reason,
      size: size ?? null,
      sniffed: refused.sniffed ?? null,
    })
    this.deps.logger.info('refused an attachment', {
      senderId: message.sender.id,
      reason: refused.reason,
    })
    const key = `${message.sender.id}:${message.mediaGroupId ?? `message:${message.messageId}`}`
    if (!this.#notices.record(key, this.deps.clock.now()).emit) return
    try {
      await this.deps.chat.sendText(
        message.chatId,
        this.deps.messages.attachmentRefused({
          reason: refused.reason,
          maxMegabytes: Math.floor(this.deps.maxBytes / 1_000_000),
          allowed: ALLOWED_EXTENSIONS,
        }),
      )
    } catch (error) {
      this.deps.logger.warn('could not send an attachment notice', { error })
    }
  }

  #audit(
    event: 'attachment.received' | 'attachment.refused',
    message: AttachmentMessage,
    details: AuditDetails,
  ): void {
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: `telegram:${message.sender.id}`,
      event,
      details: { senderId: message.sender.id, kind: message.attachment.kind, ...details },
    })
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}
