import type { CallbackHandler } from '../../application/callbacks/InboundCallback.ts'
import type { InboundHandler } from '../../application/pipeline/InboundStep.ts'
import type { InboundPoller, PollingExit } from '../../application/ports/InboundPoller.ts'
import type { Logger } from '../../application/ports/Logger.ts'
import type { PollerLock, PollerRole } from '../../application/ports/PollerLock.ts'
import { type Every, realEvery } from '../system/every.ts'

export interface PollingSupervisorOptions {
  readonly lock: PollerLock
  readonly poller: InboundPoller
  readonly handler: InboundHandler
  /** Button taps; without it they are dropped. */
  readonly callbackHandler?: CallbackHandler
  /** Runs each time this process takes the lock and starts polling. */
  readonly onPollingStarted?: () => void
  readonly logger: Logger
  readonly role: PollerRole
  readonly heartbeatMs: number
  /** While another process holds the lock, try again this often. */
  readonly retryMs: number
  readonly every?: Every
}

/**
 * Keeps the single-poller rule for the long-running channel process: polls
 * only while it holds the lock, heartbeats it, retries when another live
 * process holds it, and gives the lock back when polling ends for good.
 */
export class PollingSupervisor {
  readonly #o: PollingSupervisorOptions
  readonly #every: Every
  #cancelTimer: (() => void) | undefined
  #polling = false
  #stopped = false

  constructor(options: PollingSupervisorOptions) {
    this.#o = options
    this.#every = options.every ?? realEvery
  }

  get isPolling(): boolean {
    return this.#polling
  }

  start(): void {
    if (!this.#tryStartPolling()) this.#scheduleRetry()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#clearTimer()
    if (this.#polling) await this.#o.poller.stop()
    this.#o.lock.release()
  }

  #tryStartPolling(): boolean {
    if (this.#stopped || this.#polling) return false
    const result = this.#o.lock.tryAcquire(this.#o.role)
    if (!result.acquired) {
      this.#o.logger.info('another process polls telegram; not polling here', {
        holderPid: result.holder.pid,
        holderRole: result.holder.role,
      })
      return false
    }
    this.#polling = true
    this.#clearTimer()
    this.#cancelTimer = this.#every(this.#o.heartbeatMs, () => this.#heartbeat())
    void this.#o.poller.start(this.#o.handler, this.#o.callbackHandler).then(
      (exit) => this.#onPollingEnded(exit),
      (error: unknown) => {
        this.#o.logger.error('telegram polling crashed', { error })
        this.#onPollingEnded('stopped')
      },
    )
    this.#o.onPollingStarted?.()
    return true
  }

  #heartbeat(): void {
    if (this.#o.lock.refresh()) return
    this.#o.logger.warn('lost the telegram poller lock to another process; stopping polling')
    this.#clearTimer()
    void this.#o.poller.stop()
  }

  #onPollingEnded(exit: PollingExit): void {
    this.#polling = false
    this.#clearTimer()
    if (this.#stopped) return
    this.#o.lock.release()
    this.#o.logger.warn('telegram polling ended', { exit })
    // A bad token or a foreign poller will not fix itself; a lost lock or a crash may.
    if (exit === 'stopped') this.#scheduleRetry()
  }

  #scheduleRetry(): void {
    this.#clearTimer()
    this.#cancelTimer = this.#every(this.#o.retryMs, () => {
      this.#tryStartPolling()
    })
  }

  #clearTimer(): void {
    this.#cancelTimer?.()
    this.#cancelTimer = undefined
  }
}
