/**
 * Size bounds of a rendered chart (F11). The chart's own size comes from the
 * spec (`width`, `height`, autosize), so it is checked after layout and
 * before any pixel is drawn; the scale keeps small charts sharp on a phone.
 */

/** Longest side of the laid-out chart, in CSS pixels, before scaling. */
export const MAX_CHART_SIDE = 2_000
/** Rendered pixels (width × height) at most; the scale shrinks to fit. */
export const MAX_CHART_PIXELS = 12_000_000
/** Preferred scale: a 400 px wide chart becomes an 800 px wide image. */
export const CHART_SCALE = 2
/** Wall time for one render, from spawn to PNG, after which the renderer is killed. */
export const CHART_RENDER_TIMEOUT_MS = 20_000
/** A rendered PNG larger than this is refused (Telegram's document limit is 50 MB). */
export const MAX_CHART_PNG_BYTES = 20_000_000

export type ChartSizeCheck =
  | { readonly ok: true; readonly scale: number }
  | { readonly ok: false; readonly problem: 'empty' | 'too_big' }

/**
 * Whether a laid-out chart of `width` × `height` may be rasterized, and at
 * which scale: `CHART_SCALE` unless that would pass `MAX_CHART_PIXELS`. With
 * sides of at most 2,000 the image stays within Telegram's photo limit
 * (width + height at most 10,000).
 */
export function chartScale(width: number, height: number): ChartSizeCheck {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { ok: false, problem: 'empty' }
  }
  if (width > MAX_CHART_SIDE || height > MAX_CHART_SIDE) return { ok: false, problem: 'too_big' }
  const fit = Math.sqrt(MAX_CHART_PIXELS / (width * height))
  return { ok: true, scale: Math.min(CHART_SCALE, fit) }
}
