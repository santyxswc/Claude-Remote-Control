import { describe, expect, test } from 'bun:test'
import { chartScale, MAX_CHART_PIXELS } from '../../../src/domain/charts/chartImage.ts'
import {
  checkChartSpec,
  MAX_CHART_DATA_VALUES,
  MAX_CHART_DEPTH,
  MAX_CHART_SPEC_BYTES,
  MAX_CHART_STRING_LENGTH,
  mapChartStrings,
} from '../../../src/domain/charts/chartSpec.ts'

const bar = (values: unknown[] = [{ a: 'A', b: 1 }]) => ({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  data: { values },
  mark: 'bar',
  encoding: {
    x: { field: 'a', type: 'nominal' },
    y: { field: 'b', type: 'quantitative' },
  },
})

describe('checkChartSpec', () => {
  test('an inline bar chart passes, with its size and row count', () => {
    const result = checkChartSpec(
      bar([
        { a: 'A', b: 1 },
        { a: 'B', b: 2 },
      ]),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.stats.values).toBe(2)
      expect(result.stats.bytes).toBe(
        JSON.stringify(
          bar([
            { a: 'A', b: 1 },
            { a: 'B', b: 2 },
          ]),
        ).length,
      )
    }
  })

  test.each([
    [null, 'not_an_object'],
    [[], 'not_an_object'],
    ['spec', 'not_an_object'],
  ])('%p is %s', (spec, problem) => {
    expect(checkChartSpec(spec)).toMatchObject({ ok: false, problem })
  })

  test('a full Vega spec is refused', () => {
    expect(
      checkChartSpec({ $schema: 'https://vega.github.io/schema/vega/v6.json', marks: [] }),
    ).toEqual({ ok: false, problem: 'not_vega_lite', at: '/$schema' })
  })

  test.each([
    [{ ...bar(), data: { url: 'https://example.com/x.csv' } }, 'external_resource', '/data/url'],
    [{ ...bar(), data: { url: 'file:///etc/passwd' } }, 'external_resource', '/data/url'],
    [{ ...bar(), data: { url: 'data/cars.json' } }, 'external_resource', '/data/url'],
    [{ ...bar(), encoding: { href: { field: 'a' } } }, 'external_resource', '/encoding/href'],
    [{ ...bar(), mark: { type: 'bar', href: 'https://x' } }, 'external_resource', '/mark/href'],
    [{ ...bar(), mark: 'image' }, 'image_mark', '/mark'],
    [{ ...bar(), mark: { type: 'IMAGE' } }, 'image_mark', '/mark'],
    [{ layer: [{ ...bar(), mark: 'image' }] }, 'image_mark', '/layer/0/mark'],
    [{ ...bar(), data: { sequence: { start: 0, stop: 1e9 } } }, 'data_generator', '/data/sequence'],
    [{ ...bar(), data: { graticule: true } }, 'data_generator', '/data/graticule'],
  ])('refuses %j', (spec, problem, at) => {
    expect(checkChartSpec(spec)).toEqual({ ok: false, problem, at } as never)
  })

  test('an url nested anywhere, even in a layer or a lookup, is refused', () => {
    const spec = {
      ...bar(),
      transform: [{ lookup: 'a', from: { data: { url: 'x.json' }, key: 'a' } }],
    }
    expect(checkChartSpec(spec)).toMatchObject({ ok: false, problem: 'external_resource' })
  })

  test('prototype keys are refused', () => {
    const spec = JSON.parse('{"mark":"bar","data":{"values":[{"__proto__":{"x":1}}]}}')
    expect(checkChartSpec(spec)).toMatchObject({ ok: false, problem: 'forbidden_key' })
  })

  test('size caps', () => {
    const big = 'x'.repeat(MAX_CHART_STRING_LENGTH)
    const rows = Array.from({ length: 120 }, () => ({ a: big }))
    expect(JSON.stringify(bar(rows)).length).toBeGreaterThan(MAX_CHART_SPEC_BYTES)
    expect(checkChartSpec(bar(rows))).toMatchObject({ ok: false, problem: 'too_large' })
    expect(checkChartSpec(bar([{ a: `${big}x` }]))).toMatchObject({
      ok: false,
      problem: 'string_too_long',
    })
    const many = Array.from({ length: MAX_CHART_DATA_VALUES + 1 }, (_, i) => i)
    expect(checkChartSpec(bar(many))).toMatchObject({ ok: false, problem: 'too_many_values' })
    let deep: unknown = 1
    for (let i = 0; i <= MAX_CHART_DEPTH; i += 1) deep = { d: deep }
    expect(checkChartSpec({ ...bar(), usermeta: deep })).toMatchObject({
      ok: false,
      problem: 'too_deep',
    })
  })

  test('rows in datasets count against the limit too', () => {
    const half = Array.from({ length: MAX_CHART_DATA_VALUES / 2 + 1 }, (_, i) => i)
    expect(checkChartSpec({ ...bar(half), datasets: { other: half } })).toMatchObject({
      ok: false,
      problem: 'too_many_values',
    })
  })
})

describe('mapChartStrings', () => {
  test('maps every string, keys included, and leaves numbers alone', () => {
    const mapped = mapChartStrings({ title: 'secret', data: { values: [{ secret: 1 }] } }, (s) =>
      s.replace('secret', '[X]'),
    )
    expect(mapped).toEqual({ title: '[X]', data: { values: [{ '[X]': 1 }] } })
  })

  test('never produces a prototype key', () => {
    const mapped = mapChartStrings({ a: 1 }, () => '__proto__')
    expect(Object.keys(mapped)).toEqual([])
  })
})

describe('chartScale', () => {
  test('twice the size when it fits', () => {
    expect(chartScale(400, 300)).toEqual({ ok: true, scale: 2 })
  })

  test('less when twice would pass the pixel budget', () => {
    const result = chartScale(2000, 2000)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.scale).toBeLessThan(2)
      expect(2000 * result.scale * 2000 * result.scale).toBeLessThanOrEqual(MAX_CHART_PIXELS + 1)
    }
  })

  test('refuses empty and oversized charts', () => {
    expect(chartScale(0, 10)).toEqual({ ok: false, problem: 'empty' })
    expect(chartScale(Number.NaN, 10)).toEqual({ ok: false, problem: 'empty' })
    expect(chartScale(2001, 10)).toEqual({ ok: false, problem: 'too_big' })
  })
})
