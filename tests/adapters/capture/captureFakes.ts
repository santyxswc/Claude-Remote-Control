import { writeFileSync } from 'node:fs'
import { WINDOWS_SHOT_PATH_ENV } from '../../../src/adapters/capture/createScreenCapturers.ts'
import type { SystemProbe } from '../../../src/adapters/capture/systemProbe.ts'
import type {
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
} from '../../../src/adapters/session/processRunner.ts'
import { makePng } from '../../png.ts'

/** A machine described by the test: which files exist and what `PATH` resolves. */
export function fakeProbe(files: readonly string[] = [], onPath: Record<string, string> = {}) {
  const asked: string[] = []
  const probe: SystemProbe = {
    isFile: (path) => {
      asked.push(path)
      return files.includes(path)
    },
    which: (name) => {
      asked.push(name)
      return onPath[name]
    },
  }
  return { probe, asked }
}

export interface RunCall {
  readonly argv: readonly string[]
  readonly timeoutMs: number
  readonly options: ProcessOptions | undefined
}

/**
 * Records every program "started" and, like the real tools, writes a small
 * real PNG to the output path it was given (`--screenshot=<path>`, the
 * Windows script's env var, or the last argument).
 */
export function fakeRunner(...results: (ProcessResult | Error | 'no-file')[]): {
  run: ProcessRunner
  calls: RunCall[]
} {
  const calls: RunCall[] = []
  const run: ProcessRunner = async (argv, timeoutMs, options) => {
    calls.push({ argv, timeoutMs, options })
    const result = results.shift() ?? { exitCode: 0, timedOut: false }
    if (result instanceof Error) throw result
    if (result === 'no-file') return { exitCode: 0, timedOut: false }
    if (result.exitCode === 0) writeFileSync(outputPath(argv, options), makePng(4, 3))
    return result
  }
  return { run, calls }
}

function outputPath(argv: readonly string[], options: ProcessOptions | undefined): string {
  const fromEnv = options?.env?.[WINDOWS_SHOT_PATH_ENV]
  if (fromEnv !== undefined) return fromEnv
  const screenshot = argv.find((arg) => arg.startsWith('--screenshot='))
  if (screenshot !== undefined) return screenshot.slice('--screenshot='.length)
  const last = argv.at(-1)
  if (last === undefined) throw new Error('no output path')
  return last
}
