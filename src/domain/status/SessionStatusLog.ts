import type { ToolActivity } from './toolActivity.ts'

/**
 * What hooks said about the session, for the pinned status message (F9).
 * Only hook events (and the bridge's own knowledge) feed it, never text
 * Claude writes to the owner. Pure: callers pass the time.
 */
export type StatusSignal =
  | { readonly kind: 'turn_started' }
  /** A chat message reached the session; counts only once hooks are known to reach us. */
  | { readonly kind: 'chat_message' }
  | { readonly kind: 'tool_ran'; readonly activity: ToolActivity }
  /** A `Notification` that asks for the owner. */
  | { readonly kind: 'attention' }
  | { readonly kind: 'turn_ended' }
  /** The session or this poller ended; a new poll restarts the log. */
  | { readonly kind: 'ended' }
  | { readonly kind: 'restarted' }

export type StatusPhase = 'unknown' | 'idle' | 'working' | 'waiting' | 'ended'

export interface StatusSnapshot {
  readonly phase: StatusPhase
  /** When the phase began; undefined while unknown. */
  readonly since: number | undefined
  /** The last tool of the current turn, cleared when it ends. */
  readonly activity: ToolActivity | undefined
  readonly lastFinishedAt: number | undefined
}

export class SessionStatusLog {
  #phase: StatusPhase = 'unknown'
  #since: number | undefined
  #activity: ToolActivity | undefined
  #lastFinishedAt: number | undefined
  #hooksSeen = false
  #turnStartedAt: number | undefined

  record(signal: StatusSignal, now: number): void {
    if (signal.kind !== 'chat_message' && signal.kind !== 'restarted' && signal.kind !== 'ended') {
      this.#hooksSeen = true
    }
    switch (signal.kind) {
      case 'turn_started':
        this.#enter('working', now)
        return
      case 'chat_message':
        if (this.#hooksSeen && this.#phase !== 'ended') this.#enter('working', now)
        return
      case 'tool_ran':
        this.#enter('working', now)
        this.#activity = signal.activity
        return
      case 'attention':
        this.#enter('waiting', now)
        return
      case 'turn_ended':
        this.#enter('idle', now)
        this.#activity = undefined
        this.#lastFinishedAt = now
        return
      case 'ended':
        this.#enter('ended', now)
        this.#activity = undefined
        return
      case 'restarted':
        if (this.#phase === 'ended') {
          this.#phase = 'unknown'
          this.#since = undefined
        }
        return
    }
  }

  snapshot(): StatusSnapshot {
    return {
      phase: this.#phase,
      since: this.#since,
      activity: this.#activity,
      lastFinishedAt: this.#lastFinishedAt,
    }
  }

  /**
   * Keeps `since` while the phase stays the same: "working since" is when the
   * turn began, also after the owner answered a question in the middle of it.
   */
  #enter(phase: StatusPhase, now: number): void {
    if (this.#phase === phase) return
    if (phase === 'working') {
      if (this.#phase !== 'waiting' || this.#turnStartedAt === undefined) this.#turnStartedAt = now
      this.#since = this.#turnStartedAt
    } else {
      this.#since = now
    }
    if (phase !== 'working' && phase !== 'waiting') this.#turnStartedAt = undefined
    this.#phase = phase
  }
}
