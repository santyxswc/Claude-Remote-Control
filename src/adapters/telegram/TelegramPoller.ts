import { type Api, Bot, BotError, GrammyError } from 'grammy'
import type { Update } from 'grammy/types'
import type { CallbackHandler } from '../../application/callbacks/InboundCallback.ts'
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

/**
 * Long-polls the Bot API with grammY and hands each message to the inbound
 * pipeline. Our own loop (rather than `bot.start`) decides what is fatal:
 * 401/404 (bad token) stops at once, a persistent 409 Conflict stops after a
 * few backed-off retries, anything else retries with backoff. Errors are
 * logged only as redacted summaries.
 */
export class TelegramPoller implements InboundPoller {
  readonly #bot: Bot
  readonly #options: TelegramPollerOptions
  readonly #sleep: AbortableSleep
  #handler: InboundHandler | undefined
  #onCallback: CallbackHandler | undefined
  #abort: AbortController | undefined
  #loop: Promise<PollingExit> | undefined
  #offset = 0

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

  /** Stops polling and confirms the processed updates so they are not delivered again. */
  async stop(): Promise<void> {
    const loop = this.#loop
    if (loop === undefined) return
    this.#abort?.abort()
    await loop
    if (this.#offset > 0) {
      try {
        await this.#bot.api.getUpdates(
          { offset: this.#offset, limit: 1, timeout: 0 },
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
          { offset: this.#offset, timeout, allowed_updates: [...ALLOWED_UPDATES] },
          apiSignal(signal),
        )
        failures = 0
        conflicts = 0
        for (const update of updates) {
          this.#offset = update.update_id + 1
          await this.#dispatch(update)
        }
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
