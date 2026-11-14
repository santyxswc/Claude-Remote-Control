import { projectName } from '../../domain/notices/sessionNotices.ts'
import { SessionStatusLog, type StatusSignal } from '../../domain/status/SessionStatusLog.ts'
import { StatusUpdatePolicy } from '../../domain/status/StatusUpdatePolicy.ts'
import type { Messages, PinnedStatusView } from '../i18n/messages.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { Clock } from '../ports/Clock.ts'

export interface StatusBoardDeps {
  readonly brake: Pick<BrakeFlag, 'status'>
  /** Open permission requests of this session. */
  readonly pendingPermissions: () => number
  /** Open `ask_choice` questions of this session. */
  readonly pendingChoices: () => number
  /** The project's directory name; otherwise the last `cwd` a hook reported. */
  readonly project: string | undefined
  readonly messages: Pick<Messages, 'pinnedStatus'>
  readonly clock: Clock
}

/** Local `HH:MM` of the PC, which is what the owner reads the status against. */
export function clockTime(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * The state behind the pinned status message (F9), shared by `/pin`,
 * `/unpin` and the updater: what hooks reported (`SessionStatusLog`), when
 * to edit (`StatusUpdatePolicy`), and the rendering. The text comes only from
 * hook events and the bridge's own state (brake, pending prompts), never
 * from what Claude writes to the owner.
 */
export class StatusBoard {
  readonly policy = new StatusUpdatePolicy()
  /** Chats whose status message was already recreated once since `/pin` (then we give up). */
  readonly recreated = new Set<string>()
  readonly #log = new SessionStatusLog()
  #hookProject: string | undefined

  constructor(private readonly deps: StatusBoardDeps) {}

  record(signal: StatusSignal, cwd?: string): void {
    this.#log.record(signal, this.deps.clock.now())
    const project = projectName(cwd)
    if (project !== undefined) this.#hookProject = project
  }

  render(): string {
    return this.deps.messages.pinnedStatus(this.view())
  }

  view(): PinnedStatusView {
    const snapshot = this.#log.snapshot()
    const pendingPermissions = this.deps.pendingPermissions()
    const pendingChoices = this.deps.pendingChoices()
    const brake = this.deps.brake.status()
    const time = (ms: number | undefined) => (ms === undefined ? undefined : clockTime(ms))
    let state: PinnedStatusView['state']
    let since: number | undefined
    if (snapshot.phase === 'ended') {
      state = 'ended'
      since = snapshot.since
    } else if (brake.engaged) {
      state = 'braked'
      since = brake.record?.engagedAt
    } else if (snapshot.phase === 'waiting' || pendingPermissions + pendingChoices > 0) {
      state = 'waiting'
      since = snapshot.phase === 'waiting' ? snapshot.since : undefined
    } else {
      state = snapshot.phase
      since = snapshot.since
    }
    return {
      project: this.deps.project ?? this.#hookProject,
      state,
      since: time(since),
      activity: state === 'ended' ? undefined : snapshot.activity,
      pendingPermissions,
      pendingChoices,
      lastFinished: time(snapshot.lastFinishedAt),
    }
  }
}
