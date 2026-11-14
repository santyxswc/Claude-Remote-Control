export type ActivityState = 'busy' | 'idle' | 'unknown'

/**
 * Whether Claude is in the middle of a turn. The channel contract gives no
 * signal for this (ADR 0005); hooks will feed it in F4. Until then it is
 * `unknown`, and nothing may claim the session is busy.
 */
export interface SessionActivity {
  current(): ActivityState
}
