import type { Logger } from '../../application/ports/Logger.ts'
import type {
  InterruptResult,
  SessionController,
} from '../../application/ports/SessionController.ts'
import type { ProcessRunner } from './processRunner.ts'

/** tmux pane ids: `%` and a number. Anything else is never passed to tmux. */
const PANE_ID = /^%\d{1,9}$/

/** `tmux send-keys` returns at once; this only guards against a wedged server. */
export const TMUX_TIMEOUT_MS = 2_000

export function isTmuxPaneId(value: string | undefined): value is string {
  return value !== undefined && PANE_ID.test(value)
}

export interface TmuxSessionControllerDeps {
  /** `TMUX_PANE` of the channel process, inherited from Claude Code's pane. */
  readonly pane: string
  readonly run: ProcessRunner
  readonly logger: Logger
}

/**
 * Sends Escape to the pane Claude Code runs in, which interrupts the current
 * response (interactive mode: "Esc: stop the current response or tool call").
 * Only that pane, only that key, arguments as an array (no shell). The tmux
 * client finds its server through the inherited `TMUX` variable.
 */
export class TmuxSessionController implements SessionController {
  constructor(private readonly deps: TmuxSessionControllerDeps) {
    if (!isTmuxPaneId(deps.pane)) throw new Error('not a tmux pane id')
  }

  async interrupt(): Promise<InterruptResult> {
    const { logger } = this.deps
    try {
      const result = await this.deps.run(
        ['tmux', 'send-keys', '-t', this.deps.pane, 'Escape'],
        TMUX_TIMEOUT_MS,
      )
      if (result.exitCode === 0) {
        logger.info('sent Escape to the session pane', { pane: this.deps.pane })
        return 'sent'
      }
      logger.warn('tmux send-keys did not succeed', {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      })
      return 'failed'
    } catch (error) {
      logger.warn('could not run tmux', { error })
      return 'failed'
    }
  }
}
