import type { ActivityState, SessionActivity } from '../../application/ports/SessionActivity.ts'

/**
 * The channel contract cannot tell whether Claude is busy (ADR 0005), so
 * until hooks feed this in F4 the honest answer is always `unknown`.
 */
export class UnknownSessionActivity implements SessionActivity {
  current(): ActivityState {
    return 'unknown'
  }
}
