export type ActivityState = 'busy' | 'idle' | 'unknown'

/**
 * Whether Claude is in the middle of a turn. The channel contract gives no
 * signal for this (ADR 0005); since F4 hooks feed it (`TrackSessionActivity`).
 * Without hook signals, or once they are stale, it is `unknown`, and nothing
 * may claim the session is busy.
 */
export interface SessionActivity {
  current(): ActivityState
}
