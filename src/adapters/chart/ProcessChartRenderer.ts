import { join } from 'node:path'
import { ChartRenderError } from '../../application/errors.ts'
import type { ChartRenderer, RenderedChart } from '../../application/ports/ChartRenderer.ts'
import type { CaptureWorkspace } from '../../application/ports/ScreenCapturer.ts'
import { CHART_RENDER_TIMEOUT_MS } from '../../domain/charts/chartImage.ts'
import type { JsonObject } from '../../domain/charts/chartSpec.ts'

/** The worker prints one short JSON line; anything longer is not a result. */
const MAX_RESULT_BYTES = 64 * 1024

export const CHART_WORKER_PATH = join(import.meta.dir, 'chartWorker.ts')

export interface ProcessChartRendererOptions {
  /** Kills the worker after this long. */
  readonly timeoutMs?: number
  /** The worker script; tests point it at a stub that hangs. */
  readonly workerPath?: string
  /** The Bun executable; the running one by default. */
  readonly bun?: string
}

/**
 * Renders each chart in a fresh `bun --smol` child process (F11): the
 * channel never loads Vega or resvg, a hostile or huge spec cannot stall it,
 * and the deadline kills the child. The child gets an empty environment (no
 * bot token, no inherited variables; on Windows Bun adds only the basic
 * system ones), runs in the capture's private directory, and gets the spec
 * on stdin.
 */
export class ProcessChartRenderer implements ChartRenderer {
  readonly #timeoutMs: number
  readonly #workerPath: string
  readonly #bun: string

  constructor(options: ProcessChartRendererOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? CHART_RENDER_TIMEOUT_MS
    this.#workerPath = options.workerPath ?? CHART_WORKER_PATH
    this.#bun = options.bun ?? process.execPath
  }

  async renderChart(
    spec: JsonObject,
    workspace: CaptureWorkspace,
    signal?: AbortSignal,
  ): Promise<RenderedChart> {
    if (signal?.aborted === true) throw new ChartRenderError('failed', 'cancelled')
    const child = Bun.spawn([this.#bun, '--smol', this.#workerPath], {
      cwd: workspace.dir,
      env: { TMPDIR: workspace.dir, TEMP: workspace.dir, TMP: workspace.dir, NO_COLOR: '1' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, this.#timeoutMs)
    const kill = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', kill, { once: true })
    try {
      try {
        child.stdin.write(JSON.stringify({ spec, out: workspace.imagePath }))
        await child.stdin.end()
      } catch {
        // The child died before reading; its exit tells why.
      }
      const output = await readCapped(child.stdout, MAX_RESULT_BYTES, kill)
      await child.exited
      if (timedOut) throw new ChartRenderError('timeout')
      if (aborted(signal)) throw new ChartRenderError('failed', 'cancelled')
      return { ...parseResult(output), path: workspace.imagePath, redactions: 0 }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) {
      onOverflow()
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseResult(output: string): { width: number; height: number } {
  const line = output.trim().split('\n').at(-1) ?? ''
  let result: unknown
  try {
    result = JSON.parse(line)
  } catch {
    throw new ChartRenderError('failed', 'the renderer gave no result')
  }
  if (typeof result !== 'object' || result === null) {
    throw new ChartRenderError('failed', 'the renderer gave no result')
  }
  const { ok, width, height, reason, detail: rawDetail } = result as Record<string, unknown>
  if (ok === true) {
    if (typeof width === 'number' && typeof height === 'number') return { width, height }
    throw new ChartRenderError('failed', 'the renderer gave no size')
  }
  const detail = typeof rawDetail === 'string' ? rawDetail : undefined
  if (reason === 'invalid_spec' || reason === 'too_big') throw new ChartRenderError(reason, detail)
  throw new ChartRenderError('failed', detail)
}

/** Read at call time: the signal may have fired while awaiting. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
