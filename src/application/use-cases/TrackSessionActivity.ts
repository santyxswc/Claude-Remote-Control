import { ActivityLog } from '../../domain/session/ActivityLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { ActivityState, SessionActivity } from '../ports/SessionActivity.ts'

/**
 * Feeds `SessionActivity` from hooks: `UserPromptSubmit` (and tool runs)
 * mean busy, `Stop` means idle. A message forwarded from the chat also
 * starts a turn when the session is idle, but only once hooks have proven
 * to reach us: without them nothing would ever say the turn ended.
 */
export class TrackSessionActivity implements SessionActivity {
  readonly #log = new ActivityLog()

  constructor(private readonly clock: Clock) {}

  turnStarted(): void {
    this.#log.busy(this.clock.now())
  }

  /** `PostToolUse`: still busy, and refreshes the staleness bound. */
  toolRan(): void {
    this.#log.busy(this.clock.now())
  }

  turnEnded(): void {
    this.#log.idle(this.clock.now())
  }

  /** A chat message reached the session. Docs do not say `UserPromptSubmit` fires for it. */
  messageForwarded(): void {
    if (this.#log.hooksSeen) this.#log.busy(this.clock.now())
  }

  current(): ActivityState {
    return this.#log.current(this.clock.now())
  }
}
