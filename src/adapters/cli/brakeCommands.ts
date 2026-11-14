import type { Messages } from '../../application/i18n/messages.ts'
import type { Terminal } from '../../application/ports/Terminal.ts'
import type { EngageBrake } from '../../application/use-cases/EngageBrake.ts'
import type { ResumeSession } from '../../application/use-cases/ResumeSession.ts'
import { EXIT_OK } from './exitCodes.ts'

export interface BrakeCommandDeps {
  readonly terminal: Terminal
  readonly messages: Messages
  readonly engage: EngageBrake
  readonly resume: ResumeSession
}

/** Audit actor for everything done from this CLI. */
const ACTOR = 'terminal'

/**
 * `stop [reason]`: engages the same flag `/stop` does. It cannot reach the
 * channel's pending prompts or the tmux pane; while the brake lasts those
 * prompts cannot be approved, and Claude stops at its next tool call.
 */
export function runStop(deps: BrakeCommandDeps, reason: string | undefined): number {
  const result = deps.engage.execute({ actor: ACTOR, ...(reason === undefined ? {} : { reason }) })
  if (result.outcome === 'engaged') {
    deps.terminal.print(deps.messages.cliStopEngaged)
  } else {
    const since = result.record === undefined ? undefined : new Date(result.record.engagedAt)
    deps.terminal.print(deps.messages.cliStopAlreadyEngaged(since?.toISOString()))
  }
  return EXIT_OK
}

/** `resume`: releases the brake without the phone. */
export function runResume(deps: BrakeCommandDeps): number {
  const outcome = deps.resume.execute(ACTOR)
  deps.terminal.print(
    outcome === 'released' ? deps.messages.cliResumeReleased : deps.messages.cliResumeNotEngaged,
  )
  return EXIT_OK
}
