import type { JsonObject } from '../../domain/charts/chartSpec.ts'
import type { CaptureWorkspace } from './ScreenCapturer.ts'

export interface RenderedChart {
  /** The PNG, inside the workspace. */
  readonly path: string
  readonly width: number
  readonly height: number
  /** Strings in the spec replaced with `[REDACTED]` before drawing. */
  readonly redactions: number
}

/**
 * Draws a Vega-Lite spec into a PNG (F11). The application only ever gets
 * the decorated renderer from `buildOutbound`: every string in the spec is
 * redacted before the adapter sees it, since text drawn into pixels cannot be
 * redacted afterwards. Rejects with `ChartRenderError`.
 */
export interface ChartRenderer {
  renderChart(
    spec: JsonObject,
    workspace: CaptureWorkspace,
    signal?: AbortSignal,
  ): Promise<RenderedChart>
}
