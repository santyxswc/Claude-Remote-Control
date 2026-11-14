/** Telegram allows a single `getUpdates` consumer per bot; this lock picks it. */
export type PollerRole = 'channel' | 'cli'

export interface PollerLockHolder {
  readonly pid: number
  readonly role: PollerRole
  /** Epoch milliseconds. */
  readonly startedAt: number
}

export type PollerLockResult =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly holder: PollerLockHolder }

export interface PollerLock {
  /** Takes the lock unless a live process holds it. Stale holders are replaced. */
  tryAcquire(role: PollerRole): PollerLockResult
  /** Heartbeat. Returns false when this process no longer holds the lock. */
  refresh(): boolean
  /** Releases the lock if this process holds it. */
  release(): void
}
