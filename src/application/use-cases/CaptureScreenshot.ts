import {
  CAPTURE_KINDS,
  type CaptureKind,
  type CaptureTarget,
} from '../../domain/capture/CaptureTarget.ts'
import { type CaptureUrlProblem, parseCaptureUrl } from '../../domain/capture/captureUrl.ts'
import { chooseImageDelivery } from '../../domain/capture/imageDelivery.ts'
import { readPngSize } from '../../domain/capture/pngSize.ts'
import type { AuditDetails, AuditLog } from '../ports/AuditLog.ts'
import type { CaptureScratch } from '../ports/CaptureScratch.ts'
import type { Clock } from '../ports/Clock.ts'
import type { ImageGateway } from '../ports/ImageGateway.ts'
import type { Logger } from '../ports/Logger.ts'
import type {
  CaptureUnavailable,
  CaptureWorkspace,
  ScreenCapturer,
} from '../ports/ScreenCapturer.ts'
import { type AuthorizeReplyTarget, auditableChatId } from './AuthorizeReplyTarget.ts'

export interface CaptureRequest {
  readonly chatId: string
  /** Absent: the whole screen. Present: a page, checked by the URL policy. */
  readonly url?: string
  /** `telegram:<id>` for `/shot`, `session` for Claude's tool. */
  readonly actor: string
}

export type CaptureOutcome =
  | { readonly status: 'sent'; readonly as: 'photo' | 'document'; readonly bytes: number }
  | { readonly status: 'refused'; readonly reason: 'chat_not_allowed' | 'busy' }
  | { readonly status: 'invalid_url'; readonly problem: CaptureUrlProblem }
  | {
      readonly status: 'unavailable'
      readonly kind: CaptureKind
      readonly detail: CaptureUnavailable | undefined
    }
  | { readonly status: 'too_large'; readonly bytes: number }
  | { readonly status: 'failed'; readonly stage: 'capture' | 'send'; readonly error: string }

export interface CaptureScreenshotDeps {
  /** Strategies picked for this machine, in order of preference. */
  readonly capturers: readonly ScreenCapturer[]
  /** Why a kind no strategy covers is missing, for the answer. */
  readonly unavailable: Readonly<Partial<Record<CaptureKind, CaptureUnavailable>>>
  readonly scratch: CaptureScratch
  /** Must be the decorated gateway from `buildOutbound` (the caption is redacted). */
  readonly images: ImageGateway
  /** The same chat rule as the `reply` tool. */
  readonly target: AuthorizeReplyTarget
  /** The caption: what was captured, and that images skip redaction. */
  readonly caption: (target: CaptureTarget) => string
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
}

/**
 * `/shot` and the `send_screenshot` tool. Validates the chat and the target,
 * captures into a private temporary directory, sends the image as a photo
 * when Telegram accepts it as one and as a document otherwise, and always
 * removes the temporary files. One capture at a time per process. Audit rows
 * carry the kind, the URL's host (never its path or query), the size and the
 * outcome.
 */
export class CaptureScreenshot {
  #busy = false

  constructor(private readonly deps: CaptureScreenshotDeps) {}

  /** The kinds some strategy on this machine covers. */
  availableKinds(): readonly CaptureKind[] {
    return CAPTURE_KINDS.filter((kind) => this.#capturerFor(kind) !== undefined)
  }

  async execute(request: CaptureRequest): Promise<CaptureOutcome> {
    const checked = this.#check(request)
    if ('status' in checked) return checked
    const { target, capturer } = checked

    this.#busy = true
    let workspace: CaptureWorkspace | undefined
    try {
      workspace = await this.deps.scratch.create()
      const outcome = await this.#captureAndSend(capturer, target, workspace, request.chatId)
      return this.#finish(request, target, outcome)
    } catch (error) {
      const outcome: CaptureOutcome = { status: 'failed', stage: 'capture', error: message(error) }
      return this.#finish(request, target, outcome)
    } finally {
      if (workspace !== undefined) await this.deps.scratch.dispose(workspace)
      this.#busy = false
    }
  }

  /** Everything that is refused before anything runs: chat, URL, availability, busy. */
  #check(
    request: CaptureRequest,
  ): { readonly target: CaptureTarget; readonly capturer: ScreenCapturer } | CaptureOutcome {
    const kind: CaptureKind = request.url === undefined ? 'screen' : 'url'
    if (!this.deps.target.execute(request.chatId)) {
      return this.#finish(request, { kind }, { status: 'refused', reason: 'chat_not_allowed' })
    }
    let target: CaptureTarget = { kind: 'screen' }
    if (request.url !== undefined) {
      const parsed = parseCaptureUrl(request.url)
      if (!parsed.ok) {
        return this.#finish(request, { kind }, { status: 'invalid_url', problem: parsed.problem })
      }
      target = parsed.target
    }
    const capturer = this.#capturerFor(kind)
    if (capturer === undefined) {
      const detail = this.deps.unavailable[kind]
      return this.#finish(request, target, { status: 'unavailable', kind, detail })
    }
    if (this.#busy) return this.#finish(request, target, { status: 'refused', reason: 'busy' })
    return { target, capturer }
  }

  async #captureAndSend(
    capturer: ScreenCapturer,
    target: CaptureTarget,
    workspace: CaptureWorkspace,
    chatId: string,
  ): Promise<CaptureOutcome> {
    const image = await capturer.capture(target, workspace)
    const file = await this.deps.scratch.inspect(image.path)
    const size = image.mime === 'image/png' ? readPngSize(file.head) : undefined
    const delivery = chooseImageDelivery(file.bytes, size)
    if (delivery === 'empty') return { status: 'failed', stage: 'capture', error: 'empty image' }
    if (delivery === 'too_large') return { status: 'too_large', bytes: file.bytes }
    try {
      await this.deps.images.sendImage(
        chatId,
        { path: image.path, filename: `screenshot${extension(image.mime)}`, as: delivery },
        this.deps.caption(target),
      )
    } catch (error) {
      return { status: 'failed', stage: 'send', error: message(error) }
    }
    return { status: 'sent', as: delivery, bytes: file.bytes }
  }

  #capturerFor(kind: CaptureKind): ScreenCapturer | undefined {
    return this.deps.capturers.find((capturer) => capturer.kinds.includes(kind))
  }

  #finish(
    request: CaptureRequest,
    target: CaptureTarget | { readonly kind: CaptureKind },
    outcome: CaptureOutcome,
  ): CaptureOutcome {
    const details: AuditDetails = {
      chatId: auditableChatId(request.chatId),
      kind: target.kind,
      ...('host' in target ? { host: target.host } : {}),
      outcome: outcome.status,
      ...outcomeDetails(outcome),
    }
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: request.actor,
      event: outcome.status === 'sent' ? 'screenshot.sent' : 'screenshot.not_sent',
      details,
    })
    if (outcome.status === 'failed') {
      this.deps.logger.error('screenshot failed', { stage: outcome.stage, error: outcome.error })
    } else {
      this.deps.logger.info('screenshot request', { kind: target.kind, outcome: outcome.status })
    }
    return outcome
  }
}

/** Never the URL's path or query, never an error text: sizes and reasons only. */
function outcomeDetails(outcome: CaptureOutcome): AuditDetails {
  switch (outcome.status) {
    case 'sent':
      return { as: outcome.as, bytes: outcome.bytes }
    case 'too_large':
      return { bytes: outcome.bytes }
    case 'refused':
      return { reason: outcome.reason }
    case 'invalid_url':
      return { reason: outcome.problem }
    case 'failed':
      return { stage: outcome.stage }
    case 'unavailable':
      return { reason: outcome.detail?.reason ?? 'unknown' }
  }
}

function extension(mime: string): string {
  return mime === 'image/png' ? '.png' : ''
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
