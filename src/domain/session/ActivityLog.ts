/** A busy or idle signal older than this is no longer trusted (a crash must not leave "busy"). */
export const ACTIVITY_STALE_MS = 10 * 60_000

export type Activity = 'busy' | 'idle' | 'unknown'

/**
 * What the hooks last said about the session: a turn started (busy) or ended
 * (idle). Pure: callers pass the time. Until a signal arrives, or once the
 * last one is stale, the honest answer is `unknown`.
 */
export class ActivityLog {
  #state: 'busy' | 'idle' | undefined
  #at = 0

  /** True once any hook signal arrived, i.e. the hooks are installed and reach us. */
  get hooksSeen(): boolean {
    return this.#state !== undefined
  }

  busy(now: number): void {
    this.#state = 'busy'
    this.#at = now
  }

  idle(now: number): void {
    this.#state = 'idle'
    this.#at = now
  }

  current(now: number): Activity {
    if (this.#state === undefined || now - this.#at > ACTIVITY_STALE_MS) return 'unknown'
    return this.#state
  }
}
