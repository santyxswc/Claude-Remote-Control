/** How a command ended; `timedOut` means it was killed after the deadline. */
export interface ProcessResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
}

export interface ProcessOptions {
  /** Extra environment variables, added to this process's environment. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Runs a program with an argument array (never through a shell) and kills it
 * after `timeoutMs`. Injected so tests never start a real program.
 */
export type ProcessRunner = (
  argv: readonly string[],
  timeoutMs: number,
  options?: ProcessOptions,
) => Promise<ProcessResult>

/** The real runner: `Bun.spawn`, no stdin, output discarded. Rejects if it cannot start. */
export const spawnProcess: ProcessRunner = async (argv, timeoutMs, options) => {
  const child = Bun.spawn([...argv], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    ...(options?.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  try {
    const exitCode = await child.exited
    return { exitCode: timedOut ? null : exitCode, timedOut }
  } finally {
    clearTimeout(timer)
  }
}
