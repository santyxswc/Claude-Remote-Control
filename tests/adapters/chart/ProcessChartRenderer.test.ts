/**
 * The real chart renderer (F11): a `bun --smol` child process running Vega,
 * Vega-Lite and resvg. These tests start it for real; specs go straight to
 * the adapter, past `checkChartSpec`, to prove the process itself loads
 * nothing, runs no code from the spec and dies at the deadline.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProcessChartRenderer } from '../../../src/adapters/chart/ProcessChartRenderer.ts'
import { ChartRenderError } from '../../../src/application/errors.ts'
import type { CaptureWorkspace } from '../../../src/application/ports/ScreenCapturer.ts'
import { readPngSize } from '../../../src/domain/capture/pngSize.ts'
import type { JsonObject } from '../../../src/domain/charts/chartSpec.ts'
import { darkPixels, decodePng } from '../../png.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

const RENDER_TIMEOUT_MS = 30_000
/** A variable set in the channel's environment that must not reach the worker. */
const LEAK = 'TELEGRAM_BRIDGE_TEST_SECRET'

let dir: string
let workspace: CaptureWorkspace
let hits: string[]
let server: ReturnType<typeof Bun.serve>
let base: string

beforeAll(() => {
  // Anything the renderer fetched would show up here.
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      hits.push(new URL(request.url).pathname)
      return Response.json([{ a: 'A', b: 1 }])
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

beforeEach(() => {
  hits = []
  dir = makeTempDir()
  const scratch = join(dir, 'scratch')
  mkdirSync(scratch)
  workspace = { dir: scratch, imagePath: join(scratch, 'chart.png') }
})

afterEach(() => {
  removeTempDir(dir)
})

const renderer = new ProcessChartRenderer()

const bar = (extra: JsonObject = {}): JsonObject => ({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  data: {
    values: [
      { mes: 'Enero', ventas: 28 },
      { mes: 'Febrero', ventas: 55 },
      { mes: 'Marzo', ventas: 43 },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'mes', type: 'nominal' },
    y: { field: 'ventas', type: 'quantitative' },
  },
  ...extra,
})

async function failure(spec: JsonObject): Promise<ChartRenderError> {
  try {
    await renderer.renderChart(spec, workspace)
  } catch (error) {
    if (error instanceof ChartRenderError) return error
    throw error
  }
  throw new Error('the chart rendered')
}

describe('a real render', () => {
  test(
    'writes a PNG of the size it reports, with text drawn in the bundled font',
    async () => {
      const titled = await renderer.renderChart(bar({ title: 'Ventas por año, Ñandú' }), workspace)
      const png = readFileSync(titled.path)
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(readPngSize(png)).toEqual({ width: titled.width, height: titled.height })
      expect(titled.width).toBeGreaterThan(100)
      expect(titled.height).toBeGreaterThan(100)
      expect(titled.width).toBeLessThanOrEqual(4_000)
      const withTitle = darkPixels(decodePng(png))

      // The same chart without a title: if no font loaded, both would have the same pixels.
      const plain = await renderer.renderChart(bar(), {
        ...workspace,
        imagePath: join(workspace.dir, 'plain.png'),
      })
      const withoutTitle = darkPixels(decodePng(readFileSync(plain.path)))
      expect(withTitle - withoutTitle).toBeGreaterThan(300)
      expect(hits).toEqual([])
    },
    RENDER_TIMEOUT_MS,
  )

  test(
    'deterministic: the same spec gives the same bytes',
    async () => {
      const a = await renderer.renderChart(bar({ title: 'x' }), workspace)
      const first = readFileSync(a.path)
      const b = await renderer.renderChart(bar({ title: 'x' }), {
        ...workspace,
        imagePath: join(workspace.dir, 'again.png'),
      })
      expect(Buffer.compare(first, readFileSync(b.path))).toBe(0)
    },
    RENDER_TIMEOUT_MS,
  )

  test(
    'an invalid spec is reported as such',
    async () => {
      const error = await failure({ mark: 'no-such-mark', data: { values: [] } })
      expect(error.reason).toBe('invalid_spec')
      expect(existsSync(workspace.imagePath)).toBe(false)
    },
    RENDER_TIMEOUT_MS,
  )
})

describe('no network, no files', () => {
  test(
    'an http data url is never fetched',
    async () => {
      const error = await failure(bar({ data: { url: `${base}/data.json` } }))
      expect(error.reason).toBe('invalid_spec')
      expect(hits).toEqual([])
      expect(existsSync(workspace.imagePath)).toBe(false)
    },
    RENDER_TIMEOUT_MS,
  )

  test(
    'a file path or file: url is never read',
    async () => {
      const secret = join(dir, 'secret.json')
      writeFileSync(secret, JSON.stringify([{ mes: 'SECRET', ventas: 1 }]))
      for (const url of [secret, pathToFileURL(secret).href]) {
        const error = await failure(bar({ data: { url } }))
        expect(error.reason).toBe('invalid_spec')
        expect(existsSync(workspace.imagePath)).toBe(false)
      }
    },
    RENDER_TIMEOUT_MS,
  )

  test(
    'a relative data url (resolved against the working directory) is never read',
    async () => {
      writeFileSync(join(workspace.dir, 'data.json'), JSON.stringify([{ mes: 'x', ventas: 1 }]))
      const error = await failure(bar({ data: { url: 'data.json' } }))
      expect(error.reason).toBe('invalid_spec')
      expect(existsSync(workspace.imagePath)).toBe(false)
    },
    RENDER_TIMEOUT_MS,
  )

  test(
    'image marks and links never reach the network',
    async () => {
      const image = await failure({
        data: { values: [{ u: `${base}/pixel.png` }] },
        mark: { type: 'image', width: 10, height: 10 },
        encoding: { url: { field: 'u', type: 'nominal' } },
      })
      expect(image.reason).toBe('invalid_spec')
      try {
        await renderer.renderChart(bar({ mark: { type: 'bar', href: `${base}/link` } }), workspace)
      } catch (error) {
        expect(error).toBeInstanceOf(ChartRenderError)
      }
      expect(hits).toEqual([])
    },
    RENDER_TIMEOUT_MS,
  )
})

describe('no code from the spec runs', () => {
  test(
    'expressions that try to reach the Function constructor do nothing',
    async () => {
      const marker = join(dir, 'pwned.txt').replaceAll('\\', '/')
      const payload = `require('node:fs').writeFileSync('${marker}', 'x')`
      const hostile = [
        `datum.constructor.constructor("${payload}")()`,
        `(0).constructor.constructor("${payload}")()`,
        `datum['constructor']['constructor']("${payload}")()`,
        `toString.constructor("${payload}")()`,
        `'a'.constructor.constructor("${payload}")()`,
      ]
      for (const expression of hostile) {
        try {
          await renderer.renderChart(
            bar({ transform: [{ calculate: expression, as: 'x' }] }),
            workspace,
          )
        } catch (error) {
          expect(error).toBeInstanceOf(ChartRenderError)
        }
        expect(existsSync(marker)).toBe(false)
      }
    },
    RENDER_TIMEOUT_MS,
  )
})

test(
  'ordinary expressions still work: they are evaluated by the interpreter',
  async () => {
    const chart = await renderer.renderChart(
      bar({ transform: [{ calculate: 'datum.ventas * 2 + length(datum.mes)', as: 'doble' }] }),
      workspace,
    )
    expect(chart.width).toBeGreaterThan(0)
  },
  RENDER_TIMEOUT_MS,
)

describe('the deadline', () => {
  test(
    'a renderer that hangs is killed and reported as a timeout',
    async () => {
      const stub = join(dir, 'hang.ts')
      writeFileSync(
        stub,
        "import { writeFileSync } from 'node:fs'\nwriteFileSync('pid.txt', String(process.pid))\nsetInterval(() => {}, 1000)\n",
      )
      const hanging = new ProcessChartRenderer({ timeoutMs: 1_500, workerPath: stub })
      const started = Date.now()
      let error: unknown
      try {
        await hanging.renderChart(bar(), workspace)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(ChartRenderError)
      expect((error as ChartRenderError).reason).toBe('timeout')
      expect(Date.now() - started).toBeLessThan(10_000)
      const pid = Number(readFileSync(join(workspace.dir, 'pid.txt'), 'utf8'))
      expect(isAlive(pid)).toBe(false)
    },
    RENDER_TIMEOUT_MS,
  )

  test(
    'cancelling kills it too',
    async () => {
      const stub = join(dir, 'hang.ts')
      writeFileSync(stub, 'setInterval(() => {}, 1000)\n')
      const hanging = new ProcessChartRenderer({ timeoutMs: 60_000, workerPath: stub })
      const abort = new AbortController()
      setTimeout(() => abort.abort(), 500)
      let error: unknown
      try {
        await hanging.renderChart(bar(), workspace, abort.signal)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(ChartRenderError)
    },
    RENDER_TIMEOUT_MS,
  )

  test(
    'a worker that floods stdout is stopped and gives no result',
    async () => {
      const stub = join(dir, 'flood.ts')
      writeFileSync(stub, "for (;;) process.stdout.write('x'.repeat(65536))\n")
      const flooding = new ProcessChartRenderer({ timeoutMs: 10_000, workerPath: stub })
      let error: unknown
      try {
        await flooding.renderChart(bar(), workspace)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(ChartRenderError)
      expect((error as ChartRenderError).reason).toBe('failed')
    },
    RENDER_TIMEOUT_MS,
  )
})

describe('the environment', () => {
  test(
    'the worker inherits no variables from the channel (the bot token included)',
    async () => {
      const stub = join(dir, 'env.ts')
      writeFileSync(
        stub,
        "import { writeFileSync } from 'node:fs'\nwriteFileSync('env.json', JSON.stringify(Object.keys(process.env)))\nprocess.stdout.write(JSON.stringify({ ok: true, width: 1, height: 1 }) + '\\n')\n",
      )
      process.env[LEAK] = 'must-not-leak'
      try {
        await new ProcessChartRenderer({ workerPath: stub }).renderChart(bar(), workspace)
      } finally {
        delete process.env[LEAK]
      }
      const names = JSON.parse(readFileSync(join(workspace.dir, 'env.json'), 'utf8')) as string[]
      expect(names).not.toContain(LEAK)
      expect(names).not.toContain('TELEGRAM_BOT_TOKEN')
      expect(names).not.toContain('CLAUDE_PROJECT_DIR')
    },
    RENDER_TIMEOUT_MS,
  )
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
