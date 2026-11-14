import { chooseImageDelivery } from '../../domain/capture/imageDelivery.ts'
import { readPngSize } from '../../domain/capture/pngSize.ts'
import { MAX_CHART_PNG_BYTES } from '../../domain/charts/chartImage.ts'
import {
  type ChartSpecProblem,
  type ChartSpecStats,
  checkChartSpec,
  type JsonObject,
} from '../../domain/charts/chartSpec.ts'
import { sanitizeMultilineText } from '../../domain/displayText.ts'
import { ChartRenderError, type ChartRenderFailure } from '../errors.ts'
import type { AuditDetails, AuditLog } from '../ports/AuditLog.ts'
import type { CaptureScratch } from '../ports/CaptureScratch.ts'
import type { ChartRenderer } from '../ports/ChartRenderer.ts'
import type { Clock } from '../ports/Clock.ts'
import type { ImageGateway } from '../ports/ImageGateway.ts'
import type { Logger } from '../ports/Logger.ts'
import type { CaptureWorkspace } from '../ports/ScreenCapturer.ts'
import { type AuthorizeReplyTarget, auditableChatId } from './AuthorizeReplyTarget.ts'

/** What Claude passed to `send_chart`. Every field is untrusted. */
export interface ChartRequest {
  readonly chatId: string
  readonly spec: unknown
  readonly caption?: string
}

export type ChartOutcome =
  | {
      readonly status: 'sent'
      readonly as: 'photo' | 'document'
      readonly bytes: number
      readonly width: number
      readonly height: number
      /** Strings in the spec replaced with `[REDACTED]` before drawing. */
      readonly redactions: number
    }
  | { readonly status: 'refused'; readonly reason: 'chat_not_allowed' | 'busy' }
  | { readonly status: 'invalid_spec'; readonly problem: ChartSpecProblem; readonly at: string }
  | {
      readonly status: 'not_rendered'
      readonly reason: ChartRenderFailure
      /** The renderer's message, for Claude only: never logged or audited (it may quote the spec). */
      readonly detail: string | undefined
    }
  | { readonly status: 'too_large'; readonly bytes: number }
  | { readonly status: 'failed'; readonly stage: 'render' | 'send'; readonly error: string }

export interface SendChartDeps {
  /** The decorated renderer from `buildOutbound`: the spec's strings are redacted first. */
  readonly renderer: ChartRenderer
  readonly scratch: CaptureScratch
  /** The decorated gateway from `buildOutbound` (the caption is redacted and fitted). */
  readonly images: ImageGateway
  /** The same chat rule as the `reply` tool, without extra chats: images exist only on Telegram. */
  readonly target: AuthorizeReplyTarget
  readonly caption: (caption: string | undefined) => string
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
}

/**
 * The `send_chart` tool (F11). Checks the chat and the spec (inline data
 * only, bounded), renders one chart at a time in a private scratch
 * directory, sends the PNG as a photo (or a document when Telegram would not
 * take it as one) and always removes the directory. Audit rows carry sizes,
 * counts and the outcome, never the spec or the caption.
 */
export class SendChart {
  #running: { readonly abort: AbortController; readonly done: Promise<ChartOutcome> } | undefined

  constructor(private readonly deps: SendChartDeps) {}

  async execute(request: ChartRequest): Promise<ChartOutcome> {
    if (!this.deps.target.execute(request.chatId)) {
      return this.#finish(request, undefined, { status: 'refused', reason: 'chat_not_allowed' })
    }
    const checked = checkChartSpec(request.spec)
    if (!checked.ok) {
      const outcome: ChartOutcome = {
        status: 'invalid_spec',
        problem: checked.problem,
        at: checked.at,
      }
      return this.#finish(request, undefined, outcome)
    }
    if (this.#running !== undefined) {
      return this.#finish(request, checked.stats, { status: 'refused', reason: 'busy' })
    }
    const abort = new AbortController()
    const done = this.#run(request, request.spec as JsonObject, checked.stats, abort.signal)
    this.#running = { abort, done }
    return done
  }

  /** Cancels the render in flight, if any (the renderer is killed), and waits for its clean-up. */
  async stop(): Promise<void> {
    const running = this.#running
    if (running === undefined) return
    running.abort.abort()
    await running.done
  }

  async #run(
    request: ChartRequest,
    spec: JsonObject,
    stats: ChartSpecStats,
    signal: AbortSignal,
  ): Promise<ChartOutcome> {
    let workspace: CaptureWorkspace | undefined
    try {
      workspace = await this.deps.scratch.create()
      return this.#finish(
        request,
        stats,
        await this.#renderAndSend(request, spec, workspace, signal),
      )
    } catch (error) {
      const outcome: ChartOutcome =
        error instanceof ChartRenderError
          ? { status: 'not_rendered', reason: error.reason, detail: error.detail }
          : { status: 'failed', stage: 'render', error: message(error) }
      return this.#finish(request, stats, outcome)
    } finally {
      if (workspace !== undefined) await this.deps.scratch.dispose(workspace)
      this.#running = undefined
    }
  }

  async #renderAndSend(
    request: ChartRequest,
    spec: JsonObject,
    workspace: CaptureWorkspace,
    signal: AbortSignal,
  ): Promise<ChartOutcome> {
    const chart = await this.deps.renderer.renderChart(spec, workspace, signal)
    if (signal.aborted) return { status: 'failed', stage: 'render', error: 'cancelled' }
    const file = await this.deps.scratch.inspect(chart.path)
    if (file.bytes > MAX_CHART_PNG_BYTES) return { status: 'too_large', bytes: file.bytes }
    const size = readPngSize(file.head)
    const delivery = chooseImageDelivery(file.bytes, size)
    if (delivery === 'empty' || size === undefined) {
      return { status: 'failed', stage: 'render', error: 'the renderer produced no PNG' }
    }
    if (delivery === 'too_large') return { status: 'too_large', bytes: file.bytes }
    const caption =
      request.caption === undefined ? undefined : sanitizeMultilineText(request.caption)
    try {
      await this.deps.images.sendImage(
        request.chatId,
        { path: chart.path, filename: 'chart.png', as: delivery },
        this.deps.caption(caption),
      )
    } catch (error) {
      return { status: 'failed', stage: 'send', error: message(error) }
    }
    return {
      status: 'sent',
      as: delivery,
      bytes: file.bytes,
      width: size.width,
      height: size.height,
      redactions: chart.redactions,
    }
  }

  #finish(
    request: ChartRequest,
    stats: ChartSpecStats | undefined,
    outcome: ChartOutcome,
  ): ChartOutcome {
    const details: AuditDetails = {
      chatId: auditableChatId(request.chatId),
      ...(stats === undefined ? {} : { specBytes: stats.bytes, values: stats.values }),
      outcome: outcome.status,
      ...outcomeDetails(outcome),
    }
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: 'session',
      event: outcome.status === 'sent' ? 'chart.sent' : 'chart.not_sent',
      details,
    })
    if (outcome.status === 'failed') {
      this.deps.logger.error('chart failed', { stage: outcome.stage, error: outcome.error })
    } else {
      this.deps.logger.info('chart request', {
        outcome: outcome.status,
        ...outcomeDetails(outcome),
      })
    }
    return outcome
  }
}

/** Sizes, counts and reasons only: never the spec, the caption or the renderer's message. */
function outcomeDetails(outcome: ChartOutcome): AuditDetails {
  switch (outcome.status) {
    case 'sent':
      return {
        as: outcome.as,
        bytes: outcome.bytes,
        width: outcome.width,
        height: outcome.height,
        redactions: outcome.redactions,
      }
    case 'too_large':
      return { bytes: outcome.bytes }
    case 'refused':
      return { reason: outcome.reason }
    case 'invalid_spec':
      return { reason: outcome.problem }
    case 'not_rendered':
      return { reason: outcome.reason }
    case 'failed':
      return { stage: outcome.stage }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
