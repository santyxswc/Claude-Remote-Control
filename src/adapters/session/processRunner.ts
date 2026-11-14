/** How a command ended; `timedOut` means it was killed after the deadline. */
export interface ProcessResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
}

export interface ProcessOptions {
  /** Extra environment variables, added to this process's environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Kills the program when aborted (shutdown, M1); it then ends with `exitCode: null`. */
  readonly signal?: AbortSignal
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

export interface CaptureOptions {
  /** Where the program runs; always explicit. */
  readonly cwd: string
  /** The program's whole environment: nothing is inherited from this process. */
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
  /** Stdout beyond this many bytes is not read: the program is killed and `truncated` set. */
  readonly maxBytes: number
  readonly signal?: AbortSignal
}

export interface CapturedOutput extends ProcessResult {
  readonly stdout: Uint8Array
  readonly truncated: boolean
}

/**
 * Runs a program with an argument array (no shell), an explicit working
 * directory and environment, a timeout and a cap on the output it keeps
 * (stdout only; stderr is discarded). Injected so tests can fake it.
 */
export type CapturingProcessRunner = (
  argv: readonly string[],
  options: CaptureOptions,
) => Promise<CapturedOutput>

/** The real capturing runner: `Bun.spawn`, no stdin. Rejects if it cannot start. */
export const spawnCapturing: CapturingProcessRunner = async (argv, options) => {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: { ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, options.timeoutMs)
  const kill = () => child.kill()
  options.signal?.addEventListener('abort', kill, { once: true })
  if (options.signal?.aborted === true) child.kill()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    const reader = child.stdout.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const room = options.maxBytes - size
      if (value.length > room) {
        chunks.push(value.subarray(0, room))
        size += room
        truncated = true
        child.kill()
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(value)
      size += value.length
    }
    const exitCode = await child.exited
    const killed = timedOut || truncated || options.signal?.aborted === true
    const stdout = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      stdout.set(chunk, at)
      at += chunk.length
    }
    return { exitCode: killed ? null : exitCode, timedOut, stdout, truncated }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', kill)
  }
}

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
  const kill = () => child.kill()
  options?.signal?.addEventListener('abort', kill, { once: true })
  if (options?.signal?.aborted === true) child.kill()
  try {
    const exitCode = await child.exited
    const killed = timedOut || options?.signal?.aborted === true
    return { exitCode: killed ? null : exitCode, timedOut }
  } finally {
    clearTimeout(timer)
    options?.signal?.removeEventListener('abort', kill)
  }
}
