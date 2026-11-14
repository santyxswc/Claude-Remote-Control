import { rmSync, statSync } from 'node:fs'
import type { Logger } from '../../application/ports/Logger.ts'
import type {
  CapturedImage,
  CaptureWorkspace,
  ScreenCapturer,
} from '../../application/ports/ScreenCapturer.ts'
import type { CaptureTarget } from '../../domain/capture/CaptureTarget.ts'
import type { ProcessRunner } from '../session/processRunner.ts'

/** A screenshot tool may wait for a compositor or a permission dialog; not longer than this. */
export const SCREEN_TOOL_TIMEOUT_MS = 20_000

/** One native program that writes a PNG of the whole screen to a path we choose. */
export interface ScreenTool {
  /** For logs and messages, e.g. `grim`. */
  readonly name: string
  readonly argv: (outputPath: string) => readonly string[]
  /** Extra environment, for tools that take the path that way (PowerShell). */
  readonly env?: (outputPath: string) => Readonly<Record<string, string>>
}

export interface CommandScreenCapturerDeps {
  /** In order of preference; the factory keeps only tools that are installed. */
  readonly tools: readonly ScreenTool[]
  readonly run: ProcessRunner
  readonly logger: Logger
}

/**
 * Native full-screen capture with whichever tool works: each one is tried in
 * order until one exits 0 and leaves a non-empty file (on Wayland, grim
 * fails on compositors without screencopy, so KDE falls through to
 * spectacle). Argument arrays only, never a shell, each with a timeout.
 */
export class CommandScreenCapturer implements ScreenCapturer {
  readonly kinds = ['screen'] as const

  constructor(private readonly deps: CommandScreenCapturerDeps) {
    if (deps.tools.length === 0) throw new Error('no screen capture tool')
  }

  async capture(target: CaptureTarget, workspace: CaptureWorkspace): Promise<CapturedImage> {
    if (target.kind !== 'screen') throw new Error('native tools only capture the screen')
    const output = workspace.imagePath
    for (const tool of this.deps.tools) {
      // A tool that failed halfway must not leave its file to the next one (scrot never overwrites).
      rmSync(output, { force: true })
      try {
        const result = await this.deps.run(
          tool.argv(output),
          SCREEN_TOOL_TIMEOUT_MS,
          tool.env === undefined ? undefined : { env: tool.env(output) },
        )
        if (result.exitCode === 0 && nonEmptyFile(output)) {
          this.deps.logger.info('captured the screen', { tool: tool.name })
          return { path: output, mime: 'image/png' }
        }
        this.deps.logger.warn('screen capture tool did not produce an image', {
          tool: tool.name,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        })
      } catch (error) {
        this.deps.logger.warn('could not run a screen capture tool', { tool: tool.name, error })
      }
    }
    throw new Error(
      `no screen capture tool succeeded (${this.deps.tools.map((t) => t.name).join(', ')})`,
    )
  }
}

function nonEmptyFile(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}
