import type { NoticePolicy } from '../../domain/notices/NoticePolicy.ts'
import { attentionTrigger } from '../../domain/notices/sessionNotices.ts'
import { summarizeToolUse } from '../../domain/status/toolActivity.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { StatusBoard } from '../status/StatusBoard.ts'
import type { LocalResolution } from '../use-cases/MarkPermissionResolvedLocally.ts'
import type { NotifySessionEvent } from '../use-cases/NotifySessionEvent.ts'
import type { TrackSessionActivity } from '../use-cases/TrackSessionActivity.ts'
import { type HookEvent, parseHookEvent } from './hookEvents.ts'

export interface HookEventRouterDeps {
  readonly notify: NotifySessionEvent
  readonly activity: TrackSessionActivity
  readonly policy: NoticePolicy
  /** `MarkPermissionResolvedLocally`; absent where permissions are not relayed. */
  readonly markResolvedLocally?: (resolution: LocalResolution) => Promise<boolean>
  /** The pinned status (F9); absent where it is not wired. */
  readonly status?: Pick<StatusBoard, 'record'>
  readonly clock: Clock
  readonly logger: Logger
}

/** Bounded, so a flood of session ids cannot grow memory. */
const MAX_TRACKED_SESSIONS = 32

/** Short enough to survive elision of a long preview, long enough to tell commands apart. */
const MAX_FRAGMENT_LENGTH = 120

/** `tool_input` fields that identify a call, in order of preference. */
const IDENTIFYING_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'path']

/**
 * Validates an authenticated hook payload and hands it to the use cases:
 * `UserPromptSubmit` -> busy; `Stop` -> idle + "finished" notice;
 * `Notification` -> "needs your answer" notice; `PostToolUse` -> busy and
 * remove the buttons of a prompt answered at the terminal. Each event also
 * feeds the pinned status (F9), when it is wired.
 *
 * The MVP is one bot for one session (plan, "Restricción"), but every
 * session with the plugin's hooks reports here; session ids are only counted.
 */
export class HookEventRouter {
  readonly #sessions = new Set<string>()

  constructor(private readonly deps: HookEventRouterDeps) {}

  async handle(payload: unknown): Promise<void> {
    const parsed = parseHookEvent(payload)
    if (!parsed.ok) {
      this.deps.logger.warn('ignored a malformed hook event', { fields: parsed.fields })
      return
    }
    const event = parsed.event
    this.#noteSession(event.sessionId)
    await this.#dispatch(event)
  }

  async #dispatch(event: HookEvent): Promise<void> {
    const { activity, notify, status } = this.deps
    switch (event.name) {
      case 'UserPromptSubmit':
        activity.turnStarted()
        status?.record({ kind: 'turn_started' }, event.cwd)
        this.deps.policy.ownerWrote(this.deps.clock.now())
        return
      case 'Stop':
        activity.turnEnded()
        status?.record({ kind: 'turn_ended' }, event.cwd)
        await notify.execute({
          event: 'Stop',
          cwd: event.cwd,
          lastMessage: event.lastAssistantMessage,
        })
        return
      case 'Notification':
        if (attentionTrigger(event.notificationType) !== undefined) {
          status?.record({ kind: 'attention' }, event.cwd)
        }
        await notify.execute({
          event: 'Notification',
          cwd: event.cwd,
          message: event.message,
          notificationType: event.notificationType,
        })
        return
      case 'PostToolUse': {
        activity.toolRan()
        status?.record(
          { kind: 'tool_ran', activity: summarizeToolUse(event.toolName, event.toolInput) },
          event.cwd,
        )
        const fragment = inputFragment(event.toolInput)
        await this.deps.markResolvedLocally?.({
          toolName: event.toolName,
          ...(fragment === undefined ? {} : { inputFragment: fragment }),
        })
        return
      }
    }
  }

  #noteSession(sessionId: string | undefined): void {
    if (sessionId === undefined || this.#sessions.has(sessionId)) return
    if (this.#sessions.size >= MAX_TRACKED_SESSIONS) return
    this.#sessions.add(sessionId)
    if (this.#sessions.size > 1) {
      this.deps.logger.warn(
        'hook events come from more than one Claude Code session; notices from all of them go to the same chat',
        { sessions: this.#sessions.size },
      )
    }
  }
}

/**
 * The part of `tool_input` to look for in a relayed `input_preview`. The
 * preview is JSON text, so the value is JSON-escaped the same way (quotes,
 * Windows backslashes doubled).
 */
export function inputFragment(
  toolInput: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (toolInput === undefined) return undefined
  for (const field of IDENTIFYING_FIELDS) {
    const value = toolInput[field]
    if (typeof value === 'string' && value !== '') {
      return JSON.stringify(value).slice(1, -1).slice(0, MAX_FRAGMENT_LENGTH)
    }
  }
  return undefined
}
