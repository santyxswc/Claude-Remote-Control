import type { Logger } from '../../application/ports/Logger.ts'
import type { SessionController } from '../../application/ports/SessionController.ts'
import { NoopSessionController } from './NoopSessionController.ts'
import type { ProcessRunner } from './processRunner.ts'
import { isTmuxPaneId, TmuxSessionController } from './TmuxSessionController.ts'

const TMUX_ENV = 'TMUX'
const TMUX_PANE_ENV = 'TMUX_PANE'

export interface SessionControllerContext {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly run: ProcessRunner
  readonly logger: Logger
}

/**
 * GoF Factory Method: tmux on Linux when this process runs inside a tmux
 * pane (`TMUX` and a valid `TMUX_PANE`, inherited from Claude Code), the
 * no-op everywhere else. Keystroke injection on Windows and macOS is out of
 * scope (ADR 0003): there the PreToolUse brake is the only stop.
 */
export function createSessionController(context: SessionControllerContext): SessionController {
  const { env } = context
  const pane = env[TMUX_PANE_ENV]
  const tmux = env[TMUX_ENV]
  const inTmux = tmux !== undefined && tmux !== '' && isTmuxPaneId(pane)
  if (context.platform === 'linux' && inTmux) {
    return new TmuxSessionController({ pane, run: context.run, logger: context.logger })
  }
  return new NoopSessionController()
}
