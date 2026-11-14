import { type JsonObject, mapChartStrings } from '../../domain/charts/chartSpec.ts'
import type { SecretRedactor } from '../../domain/redaction/SecretRedactor.ts'
import type { ChartRenderer, RenderedChart } from '../ports/ChartRenderer.ts'
import type { CaptureWorkspace } from '../ports/ScreenCapturer.ts'

/**
 * A chart's text (titles, labels, data values, field names shown as axis
 * titles) becomes pixels, which cannot be redacted. So every string in the
 * spec, keys included, is redacted first, and only then drawn.
 */
export class RedactingChartRenderer implements ChartRenderer {
  constructor(
    private readonly inner: ChartRenderer,
    private readonly redactor: SecretRedactor,
  ) {}

  async renderChart(
    spec: JsonObject,
    workspace: CaptureWorkspace,
    signal?: AbortSignal,
  ): Promise<RenderedChart> {
    let redactions = 0
    const redacted = mapChartStrings(spec, (text) => {
      const result = this.redactor.redact(text)
      redactions += result.count
      return result.text
    })
    const rendered = await this.inner.renderChart(redacted, workspace, signal)
    return { ...rendered, redactions: rendered.redactions + redactions }
  }
}
