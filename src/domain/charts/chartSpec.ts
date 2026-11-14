/**
 * What a `send_chart` specification may contain (F11), as pure checks over
 * the JSON Claude sent. The renderer refuses every load on its own; these
 * checks reject the spec earlier, with a reason Claude can act on, and bound
 * the work a render can be asked to do.
 */
import { utf8Length } from '../utf8Length.ts'

/** The spec as JSON text, in UTF-8 bytes. */
export const MAX_CHART_SPEC_BYTES = 200_000
/** Rows across every inline `values` array and every named dataset. */
export const MAX_CHART_DATA_VALUES = 5_000
/** JSON values (objects, arrays, scalars) in the whole spec. */
export const MAX_CHART_NODES = 60_000
/** Nesting of objects and arrays. */
export const MAX_CHART_DEPTH = 32
/** Longest single string (a title, a label, a data value, an expression), in UTF-16 units. */
export const MAX_CHART_STRING_LENGTH = 2_000

/** Any object key by these names asks Vega to fetch something, or links out. */
const EXTERNAL_KEYS: ReadonlySet<string> = new Set(['url', 'href'])
/** Vega-Lite data generators: rows made from a range, so the row cap would not bound them. */
const GENERATOR_KEYS: ReadonlySet<string> = new Set(['sequence', 'graticule'])
/** Keys that reach object prototypes when a library merges the spec into its config. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export type ChartSpecProblem =
  | 'not_an_object'
  | 'not_vega_lite'
  | 'too_large'
  | 'too_deep'
  | 'too_many_nodes'
  | 'too_many_values'
  | 'string_too_long'
  | 'external_resource'
  | 'image_mark'
  | 'data_generator'
  | 'forbidden_key'

export interface ChartSpecStats {
  readonly bytes: number
  /** Inline data rows (every `values` array and named dataset). */
  readonly values: number
  readonly nodes: number
}

export type ChartSpecCheck =
  | { readonly ok: true; readonly stats: ChartSpecStats }
  | {
      readonly ok: false
      readonly problem: ChartSpecProblem
      /** Where, as a JSON pointer (`/data/url`); keys are cut to stay short. */
      readonly at: string
    }

/** A JSON object as parsed from the tool call. */
export type JsonObject = { readonly [key: string]: unknown }

class Refusal {
  constructor(
    readonly problem: ChartSpecProblem,
    readonly at: string,
  ) {}
}

/**
 * Checks a Vega-Lite spec: a JSON object with inline data only. Refuses any
 * `url` or `href` key (data, images, links), image marks, data generators,
 * prototype keys, and anything over the size, row, node, depth or string
 * limits. Never throws.
 */
export function checkChartSpec(spec: unknown): ChartSpecCheck {
  if (!isPlainObject(spec)) return { ok: false, problem: 'not_an_object', at: '' }
  const { $schema: schema } = spec
  if (typeof schema === 'string' && /\/schema\/vega\//i.test(schema)) {
    return { ok: false, problem: 'not_vega_lite', at: '/$schema' }
  }
  const counter = { nodes: 0, values: 0 }
  try {
    walk(spec, '', 0, counter)
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, problem: error.problem, at: error.at }
    throw error
  }
  const bytes = utf8Length(JSON.stringify(spec))
  if (bytes > MAX_CHART_SPEC_BYTES) return { ok: false, problem: 'too_large', at: '' }
  return { ok: true, stats: { bytes, values: counter.values, nodes: counter.nodes } }
}

function walk(
  value: unknown,
  at: string,
  depth: number,
  counter: { nodes: number; values: number },
) {
  counter.nodes += 1
  if (counter.nodes > MAX_CHART_NODES) throw new Refusal('too_many_nodes', at)
  if (typeof value === 'string') {
    if (value.length > MAX_CHART_STRING_LENGTH) throw new Refusal('string_too_long', at)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (depth >= MAX_CHART_DEPTH) throw new Refusal('too_deep', at)
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, `${at}/${index}`, depth + 1, counter)
    })
    return
  }
  const object = value as JsonObject
  const { mark } = object
  if (isImageMark(mark)) throw new Refusal('image_mark', `${at}/mark`)
  for (const key of Object.keys(object)) {
    const here = `${at}/${pointerKey(key)}`
    if (key.length > MAX_CHART_STRING_LENGTH) throw new Refusal('string_too_long', here)
    if (PROTOTYPE_KEYS.has(key)) throw new Refusal('forbidden_key', here)
    if (EXTERNAL_KEYS.has(key)) throw new Refusal('external_resource', here)
    if (GENERATOR_KEYS.has(key)) throw new Refusal('data_generator', here)
    const child = object[key]
    if (key === 'values' && Array.isArray(child)) countValues(child.length, here, counter)
    if (key === 'datasets' && isPlainObject(child)) {
      for (const name of Object.keys(child)) {
        const rows = child[name]
        if (Array.isArray(rows)) countValues(rows.length, `${here}/${pointerKey(name)}`, counter)
      }
    }
    walk(child, here, depth + 1, counter)
  }
}

function countValues(rows: number, at: string, counter: { values: number }): void {
  counter.values += rows
  if (counter.values > MAX_CHART_DATA_VALUES) throw new Refusal('too_many_values', at)
}

function isImageMark(mark: unknown): boolean {
  if (typeof mark === 'string') return mark.toLowerCase() === 'image'
  if (!isPlainObject(mark)) return false
  const { type } = mark
  return typeof type === 'string' && type.toLowerCase() === 'image'
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON pointer escaping, and at most 40 characters per key so a reason stays short. */
function pointerKey(key: string): string {
  const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1')
  return escaped.length > 40 ? `${escaped.slice(0, 39)}…` : escaped
}

/**
 * A copy of the spec with every string, keys included, passed through `map`.
 * The chart's text (titles, labels, data values, field names that become
 * axis titles) is drawn into pixels and cannot be redacted afterwards, so
 * redaction happens here, before rendering. A key and a reference to it map
 * the same way, so fields still match unless two keys collapse into one.
 */
export function mapChartStrings(spec: JsonObject, map: (text: string) => string): JsonObject {
  return mapValue(spec, map) as JsonObject
}

function mapValue(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value)
  if (Array.isArray(value)) return value.map((item) => mapValue(item, map))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const mapped = map(key)
    // Never let a mapped key turn into a prototype key.
    if (PROTOTYPE_KEYS.has(mapped)) continue
    out[mapped] = mapValue(value[key], map)
  }
  return out
}
