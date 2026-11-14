/**
 * The chart libraries are loaded only by the worker process (F11): the
 * channel never imports them, so its startup stays fast and a spec can never
 * run inside it.
 */
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { extractImports } from '../../../scripts/architecture.ts'

const srcRoot = join(import.meta.dir, '..', '..', '..', 'src')
const CHART_LIBRARIES = /^(?:vega|vega-lite|vega-interpreter|@resvg\/resvg-wasm)(?:\/|$)/

test('only the chart worker imports Vega, Vega-Lite or resvg', () => {
  const importers = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .filter((entry) =>
      extractImports(readFileSync(join(srcRoot, entry), 'utf8')).some((s) =>
        CHART_LIBRARIES.test(s),
      ),
    )
    .map((entry) => relative(srcRoot, join(srcRoot, entry)).split(sep).join('/'))
  expect(importers).toEqual(['adapters/chart/chartWorker.ts'])
})

test('the worker loads them lazily, after reading its input', () => {
  const worker = readFileSync(join(srcRoot, 'adapters', 'chart', 'chartWorker.ts'), 'utf8')
  expect(worker).not.toMatch(/^import .* from '(?:vega|@resvg)/m)
  expect(worker).toContain("import('vega')")
})
