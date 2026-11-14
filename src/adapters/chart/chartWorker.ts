/**
 * The chart renderer's own process (F11). `ProcessChartRenderer` starts it
 * with `bun --smol`, a scrubbed environment and a private scratch directory
 * as its working directory, writes `{ spec, out }` on stdin and kills it at
 * the deadline. It loads Vega, Vega-Lite and resvg (the channel process never
 * does), draws the chart to SVG with no browser and no renderer, rasterizes it
 * with resvg compiled to WebAssembly, writes the PNG to `out` and prints one
 * JSON line. Nothing else goes to stdout.
 *
 * What a spec cannot do here, whatever it contains:
 * - load anything: the Vega loader refuses every load and sanitize call
 *   (data URLs, files, image and link hrefs), and the render fails if one
 *   was attempted;
 * - run code: expressions are parsed to an AST and evaluated by
 *   `vega-interpreter`, never compiled with `Function`, and `Function`,
 *   `eval` and the function constructors are replaced with throwing stubs
 *   once the libraries are loaded;
 * - reach the file system or network through the rasterizer: resvg runs in
 *   WebAssembly with only the bundled fonts handed to it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chartScale, MAX_CHART_SIDE } from '../../domain/charts/chartImage.ts'

const FONT_DIR = join(import.meta.dir, '..', '..', '..', 'assets', 'fonts')
export const CHART_FONT_FILES = ['NotoSans-Latin-Regular.ttf', 'NotoSans-Latin-Bold.ttf']
export const CHART_FONT_FAMILY = 'Noto Sans'

type Result =
  | { readonly ok: true; readonly width: number; readonly height: number }
  | {
      readonly ok: false
      readonly reason: 'invalid_spec' | 'too_big' | 'failed'
      readonly detail: string
    }

class RenderRefusal extends Error {
  constructor(
    readonly reason: 'invalid_spec' | 'too_big',
    message: string,
  ) {
    super(message)
  }
}

function blocked(): never {
  throw new Error('code generation is disabled in the chart renderer')
}

/** After the libraries are loaded: no string becomes code from here on. */
function lockDownCodeGeneration(): void {
  const constructors = [() => {}, async () => {}, function* () {}, async function* () {}].map(
    (fn) => Object.getPrototypeOf(fn) as object,
  )
  for (const prototype of constructors) {
    Object.defineProperty(prototype, 'constructor', { value: blocked, writable: false })
  }
  const global = globalThis as Record<string, unknown>
  for (const name of ['Function', 'eval', 'fetch', 'WebSocket', 'XMLHttpRequest']) {
    try {
      Object.defineProperty(global, name, { value: blocked, writable: false, configurable: false })
    } catch {
      // Not configurable here; the loader and the interpreter still never use it.
    }
  }
}

async function render(input: { spec: unknown; out: string }): Promise<Result> {
  const [vega, vegaLite, interpreter, resvg] = await Promise.all([
    import('vega'),
    import('vega-lite'),
    import('vega-interpreter'),
    import('@resvg/resvg-wasm'),
  ])
  await resvg.initWasm(
    readFileSync(Bun.resolveSync('@resvg/resvg-wasm/index_bg.wasm', import.meta.dir)),
  )
  const fonts = CHART_FONT_FILES.map((file) => new Uint8Array(readFileSync(join(FONT_DIR, file))))
  lockDownCodeGeneration()

  const attempts: string[] = []
  const refuse = async (): Promise<never> => {
    attempts.push('load')
    throw new Error('loading external resources is disabled')
  }
  const loader = { load: refuse, sanitize: refuse, http: refuse, file: refuse }

  let vegaSpec: unknown
  try {
    vegaSpec = vegaLite.compile(input.spec as never).spec
  } catch (error) {
    throw new RenderRefusal('invalid_spec', `Vega-Lite: ${message(error)}`)
  }
  let runtime: ReturnType<typeof vega.parse>
  try {
    runtime = vega.parse(vegaSpec as never, undefined, { ast: true })
  } catch (error) {
    throw new RenderRefusal('invalid_spec', `Vega: ${message(error)}`)
  }
  const view = new vega.View(runtime, {
    renderer: 'none',
    expr: interpreter.expressionInterpreter,
    loader: loader as never,
    logLevel: vega.Error,
  })
  try {
    await view.runAsync()
    const width = view.width()
    const height = view.height()
    if (width > 2 * MAX_CHART_SIDE || height > 2 * MAX_CHART_SIDE) {
      throw new RenderRefusal('too_big', `the chart is ${width}x${height} before axes`)
    }
    const svg = await view.toSVG()
    if (attempts.length > 0) {
      throw new RenderRefusal('invalid_spec', 'the spec tried to load an external resource')
    }
    const size = /^<svg[^>]*?\swidth="([\d.]+)"[^>]*?\sheight="([\d.]+)"/.exec(svg)
    const fit = chartScale(Number(size?.[1]), Number(size?.[2]))
    if (!fit.ok) throw new RenderRefusal('too_big', `the chart is ${size?.[1]}x${size?.[2]}`)
    const image = new resvg.Resvg(svg, {
      font: {
        fontBuffers: fonts,
        defaultFontFamily: CHART_FONT_FAMILY,
        sansSerifFamily: CHART_FONT_FAMILY,
        serifFamily: CHART_FONT_FAMILY,
        monospaceFamily: CHART_FONT_FAMILY,
        cursiveFamily: CHART_FONT_FAMILY,
        fantasyFamily: CHART_FONT_FAMILY,
      },
      fitTo: { mode: 'zoom', value: fit.scale },
      background: 'white',
    }).render()
    writeFileSync(input.out, image.asPng(), { mode: 0o600 })
    return { ok: true, width: image.width, height: image.height }
  } finally {
    view.finalize()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<void> {
  // Vega and its dependencies may log: keep stdout for the one result line.
  console.log = console.error
  console.info = console.error
  // Bun builds process.stdout lazily from internals that need `Function`: build it before the lock-down.
  const stdout = process.stdout
  let result: Result
  try {
    const input = JSON.parse(await Bun.stdin.text()) as { spec: unknown; out: string }
    result = await render(input)
  } catch (error) {
    result =
      error instanceof RenderRefusal
        ? { ok: false, reason: error.reason, detail: error.message.slice(0, 500) }
        : { ok: false, reason: 'failed', detail: message(error).slice(0, 500) }
  }
  // Exit only once the line is flushed; timers a spec may have started must not keep the process alive.
  stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0))
}

if (import.meta.main) await main()
