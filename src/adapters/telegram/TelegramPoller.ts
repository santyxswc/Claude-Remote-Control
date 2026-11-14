import { type Api, Bot, BotError, GrammyError } from 'grammy'
import type { Update } from 'grammy/types'
import type { CallbackHandler } from '../../application/callbacks/InboundCallback.ts'
import type { InboundMessage } from '../../application/pipeline/InboundMessage.ts'
import type { InboundHandler } from '../../application/pipeline/InboundStep.ts'
import type { InboundPoller, PollingExit } from '../../application/ports/InboundPoller.ts'
import type { Logger } from '../../application/ports/Logger.ts'
import { describeTelegramError, isTokenRejection } from './redact.ts'
import { toInboundCallback, toInboundMessage } from './toInboundMessage.ts'

/** Only what we handle (texts and button taps); everything else is never delivered to us. */
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const

export type AbortableSleep = (ms: number, signal: AbortSignal) => Promise<void>

export interface TelegramPollerOptions {
  readonly token: string
  readonly logger: Logger
  /** Replaces the network, for tests. */
  readonly fetch?: typeof fetch
  /** Long-poll duration of each `getUpdates`, in seconds. */
  readonly pollTimeoutSeconds?: number
  /** Consecutive 409 Conflicts before giving up (another process polls the same bot). */
  readonly maxConflicts?: number
  readonly sleep?: AbortableSleep
  /**
   * Messages that get a lane of their own per chat, so they never wait behind
   * slower work of that chat (`/stop`, M1). Everything else of a chat stays in order.
   */
  readonly isUrgent?: (message: InboundMessage) => boolean
}

/**
 * grammY's Node build types its signals as the `abort-controller` polyfill;
 * it only needs `aborted` and `addEventListener`, which native signals have.
 */
type ApiSignal = Parameters<Api['getUpdates']>[1]
const apiSignal = (signal: AbortSignal) => signal as unknown as ApiSignal

const DEFAULT_POLL_TIMEOUT_SECONDS = 30
const DEFAULT_MAX_CONFLICTS = 8
const MAX_BACKOFF_MS = 15_000
/** While work is in flight, how often to look for new updates (a `/stop`). */
const IN_FLIGHT_RECHECK_MS = 500
/** A quick handler finishes within this; then the next poll confirms it at once. */
const SETTLE_GRACE_MS = 25
/** Updates held back from confirmation at most; beyond, they are confirmed while in flight. */
const MAX_UNCONFIRMED = 50
/** Handlers in flight at most before polling waits for one to finish (backpressure). */
const MAX_IN_FLIGHT = 200
/** How long `stop` waits for handlers in flight. */
const DRAIN_MS = 1500

/**
 * Long-polls the Bot API with grammY and hands each message to the inbound
 * pipeline. Our own loop (rather than `bot.start`) decides what is fatal:
 * 401/404 (bad token) stops at once, a persistent 409 Conflict stops after a
 * few backed-off retries, anything else retries with backoff. Errors are
 * logged only as redacted summaries.
 *
 * Handlers never block polling (M1): each update joins a lane (per chat;
 * taps and urgent commands have their own), lanes run concurrently and each
 * one in order. An update is confirmed to Telegram only once handled, or
 * when more than `MAX_UNCONFIRMED` are pending; redelivered ones are skipped.
 */
export class TelegramPoller implements InboundPoller {
  readonly #bot: Bot
  readonly #options: TelegramPollerOptions
  readonly #sleep: AbortableSleep
  #handler: InboundHandler | undefined
  #onCallback: CallbackHandler | undefined
  #abort: AbortController | undefined
  #loop: Promise<PollingExit> | undefined
  /** Every update below this id has been dispatched. */
  #next = 0
  readonly #inFlight = new Map<number, Promise<void>>()
  readonly #lanes = new Map<string, Promise<void>>()

  constructor(options: TelegramPollerOptions) {
    this.#options = options
    this.#sleep = options.sleep ?? abortableSleep
    const timeout = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS
    this.#bot = new Bot(options.token, {
      client: {
        timeoutSeconds: timeout + 15,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      },
    })
    this.#bot.on('message', async (ctx) => {
      await this.#handler?.(toInboundMessage(ctx.message))
    })
    // Without a callback handler (the `pair` CLI) taps are dropped unanswered.
    this.#bot.on('callback_query', async (ctx) => {
      await this.#onCallback?.(toInboundCallback(ctx.callbackQuery))
    })
  }

  start(handler: InboundHandler, onCallback?: CallbackHandler): Promise<PollingExit> {
    if (this.#loop !== undefined) throw new Error('already polling')
    this.#handler = handler
    this.#onCallback = onCallback
    this.#abort = new AbortController()
    this.#loop = this.#run(this.#abort.signal).finally(() => {
      this.#loop = undefined
    })
    return this.#loop
  }

  /**
   * Stops polling, waits (briefly) for the handlers in flight, and confirms
   * the handled updates so they are not delivered again.
   */
  async stop(): Promise<void> {
    const loop = this.#loop
    if (loop === undefined) return
    this.#abort?.abort()
    await loop
    const drained = Promise.all(this.#inFlight.values()).then(() => true)
    const timedOut = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), DRAIN_MS).unref?.()
    })
    if (!(await Promise.race([drained, timedOut]))) {
      this.#options.logger.warn('stopping with inbound handlers still running', {
        count: this.#inFlight.size,
      })
    }
    const offset = this.#confirmOffset()
    if (offset > 0) {
      try {
        await this.#bot.api.getUpdates(
          { offset, limit: 1, timeout: 0 },
          apiSignal(AbortSignal.timeout(5000)),
        )
      } catch {
        // Best effort: unconfirmed updates are redelivered and ignored by the pipeline.
      }
    }
  }

  async #run(signal: AbortSignal): Promise<PollingExit> {
    const { logger, token } = this.#options
    const timeout = this.#options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS
    const maxConflicts = this.#options.maxConflicts ?? DEFAULT_MAX_CONFLICTS
    let failures = 0
    let conflicts = 0

    while (!signal.aborted) {
      try {
        if (!this.#bot.isInited()) {
          this.#bot.botInfo = await this.#bot.api.getMe(apiSignal(signal))
          logger.info('telegram polling started', { bot: this.#bot.botInfo.username })
        }
        const updates = await this.#bot.api.getUpdates(
          { offset: this.#confirmOffset(), timeout, allowed_updates: [...ALLOWED_UPDATES] },
          apiSignal(signal),
        )
        failures = 0
        conflicts = 0
        const fresh = updates.filter((update) => update.update_id >= this.#next)
        for (const update of fresh) {
          this.#next = update.update_id + 1
          this.#enqueue(update)
        }
        await this.#pace(fresh.length, signal)
      } catch (error) {
        if (signal.aborted) break
        if (isTokenRejection(error)) {
          logger.error('telegram rejected the bot token; polling stopped (run init again)', {
            error: describeTelegramError(error, token),
          })
          return 'unauthorized'
        }
        const isConflict = error instanceof GrammyError && error.error_code === 409
        if (isConflict && ++conflicts >= maxConflicts) {
          logger.error('another process keeps polling this bot (409 Conflict); polling stopped', {
            attempts: conflicts,
          })
          return 'conflict'
        }
        failures += 1
        const retryInMs = Math.min(1000 * failures, MAX_BACKOFF_MS)
        logger.warn('telegram polling failed; retrying', {
          error: describeTelegramError(error, token),
          retryInMs,
        })
        await this.#sleep(retryInMs, signal)
      }
    }
    return 'stopped'
  }

  /** The oldest update still in flight (not confirmed yet), unless too many are pending. */
  #confirmOffset(): number {
    let oldest = this.#next
    for (const id of this.#inFlight.keys()) oldest = Math.min(oldest, id)
    return this.#next - oldest > MAX_UNCONFIRMED ? this.#next : oldest
  }

  /** Joins the update's lane; never rejects (`#dispatch` logs failures). */
  #enqueue(update: Update): void {
    const lane = this.#laneOf(update)
    const previous = this.#lanes.get(lane) ?? Promise.resolve()
    const run = previous.then(() => this.#dispatch(update))
    this.#lanes.set(lane, run)
    this.#inFlight.set(update.update_id, run)
    void run.then(() => {
      this.#inFlight.delete(update.update_id)
      if (this.#lanes.get(lane) === run) this.#lanes.delete(lane)
    })
  }

  #laneOf(update: Update): string {
    if (update.message !== undefined) {
      const chat = String(update.message.chat.id)
      let urgent = false
      try {
        urgent = this.#options.isUrgent?.(toInboundMessage(update.message)) === true
      } catch {
        // A classifier bug must not lose the update: it just keeps the chat's order.
      }
      return `${urgent ? 'urgent' : 'chat'}:${chat}`
    }
    const tap = update.callback_query
    return `tap:${tap?.message?.chat.id ?? tap?.from.id ?? 'unknown'}`
  }

  /**
   * Before the next poll: give quick handlers a moment, so they are confirmed
   * at once; while some are still running, poll again only every so often (a
   * poll returns at once while unconfirmed updates exist); never let more
   * than `MAX_IN_FLIGHT` pile up.
   */
  async #pace(dispatched: number, signal: AbortSignal): Promise<void> {
    if (this.#inFlight.size === 0) return
    const anySettled = () => Promise.race(this.#inFlight.values())
    if (dispatched > 0) {
      await Promise.race([Promise.all(this.#inFlight.values()), delay(SETTLE_GRACE_MS)])
      if (this.#inFlight.size === 0) return
    }
    while (this.#inFlight.size >= MAX_IN_FLIGHT && !signal.aborted) {
      await Promise.race([anySettled(), this.#sleep(IN_FLIGHT_RECHECK_MS, signal)])
    }
    if (dispatched === 0 && this.#confirmOffset() < this.#next) {
      await Promise.race([anySettled(), this.#sleep(IN_FLIGHT_RECHECK_MS, signal)])
    }
  }

  async #dispatch(update: Update): Promise<void> {
    try {
      await this.#bot.handleUpdate(update)
    } catch (error) {
      const cause = error instanceof BotError ? error.error : error
      this.#options.logger.error('inbound handler failed', {
        updateId: update.update_id,
        error: describeTelegramError(cause, this.#options.token),
      })
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
