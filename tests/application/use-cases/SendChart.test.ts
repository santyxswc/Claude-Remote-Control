import { describe, expect, test } from 'bun:test'
import { ChartRenderError } from '../../../src/application/errors.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { RedactingChartRenderer } from '../../../src/application/outbound/RedactingChartRenderer.ts'
import type { ChartRenderer, RenderedChart } from '../../../src/application/ports/ChartRenderer.ts'
import type { CaptureWorkspace } from '../../../src/application/ports/ScreenCapturer.ts'
import { AuthorizeReplyTarget } from '../../../src/application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { SendChart } from '../../../src/application/use-cases/SendChart.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import type { JsonObject } from '../../../src/domain/charts/chartSpec.ts'
import { createSecretRedactor } from '../../../src/domain/redaction/secretValues.ts'
import {
  ALICE,
  FakeCaptureScratch,
  FakeClock,
  FakeImageGateway,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  MALLORY,
  MemoryLogger,
} from '../../fakes.ts'
import { makePng } from '../../png.ts'

const en = messagesFor('en')
const SECRET = 'Zq8vN3pL0xW7rT2yK5mB'

const spec = (title = 'Sales') => ({
  title,
  data: { values: [{ a: 'A', b: 1 }] },
  mark: 'bar',
  encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } },
})

/** "Draws" a PNG into the fake scratch and records the spec it was given. */
class FakeChartRenderer implements ChartRenderer {
  readonly specs: JsonObject[] = []
  failWith: Error | undefined
  gate: Promise<void> | undefined
  png = makePng(40, 30)

  constructor(private readonly scratch: FakeCaptureScratch) {}

  async renderChart(
    chart: JsonObject,
    workspace: CaptureWorkspace,
    signal?: AbortSignal,
  ): Promise<RenderedChart> {
    this.specs.push(chart)
    await this.gate
    if (signal?.aborted === true) throw new ChartRenderError('failed', 'cancelled')
    if (this.failWith !== undefined) throw this.failWith
    this.scratch.files.set(workspace.imagePath, this.png)
    return { path: workspace.imagePath, width: 40, height: 30, redactions: 0 }
  }
}

function harness() {
  const clock = new FakeClock()
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, clock.now()))
  const scratch = new FakeCaptureScratch()
  const raw = new FakeChartRenderer(scratch)
  const images = new FakeImageGateway()
  const audit = new InMemoryAuditLog()
  const logger = new MemoryLogger()
  const charts = new SendChart({
    renderer: new RedactingChartRenderer(raw, createSecretRedactor([SECRET])),
    scratch,
    images,
    target: new AuthorizeReplyTarget(new AuthorizeSender(allowed)),
    caption: (caption) => en.chartCaption(caption),
    audit,
    clock,
    logger,
  })
  return { raw, scratch, images, audit, logger, charts }
}

describe('SendChart', () => {
  test('renders, sends the PNG as a photo and always removes the scratch directory', async () => {
    const h = harness()
    const outcome = await h.charts.execute({ chatId: ALICE.id, spec: spec(), caption: 'Q3' })
    expect(outcome).toEqual({
      status: 'sent',
      as: 'photo',
      bytes: h.raw.png.length,
      width: 40,
      height: 30,
      redactions: 0,
    })
    expect(h.images.sent).toHaveLength(1)
    expect(h.images.sent[0]?.image.filename).toBe('chart.png')
    expect(h.images.sent[0]?.caption).toBe(en.chartCaption('Q3'))
    expect(h.scratch.live).toBe(0)
    expect(h.audit.entries).toMatchObject([
      { event: 'chart.sent', details: { outcome: 'sent', values: 1, width: 40 } },
    ])
  })

  test('strings in the spec are redacted before the renderer sees them', async () => {
    const h = harness()
    const outcome = await h.charts.execute({ chatId: ALICE.id, spec: spec(`key ${SECRET}`) })
    expect(JSON.stringify(h.raw.specs)).not.toContain(SECRET)
    expect(outcome).toMatchObject({ status: 'sent', redactions: 1 })
  })

  test('audit rows and logs carry sizes and outcomes, never the spec or the caption', async () => {
    const h = harness()
    await h.charts.execute({
      chatId: ALICE.id,
      spec: spec('Private title'),
      caption: 'Secret plan',
    })
    h.raw.failWith = new ChartRenderError('invalid_spec', 'Vega-Lite: bad field "Private title"')
    await h.charts.execute({ chatId: ALICE.id, spec: spec('Private title') })
    const recorded = JSON.stringify([h.audit.entries, h.logger.entries])
    expect(recorded).not.toContain('Private title')
    expect(recorded).not.toContain('Secret plan')
  })

  test('another chat is refused before anything is drawn', async () => {
    const h = harness()
    expect(await h.charts.execute({ chatId: MALLORY.id, spec: spec() })).toEqual({
      status: 'refused',
      reason: 'chat_not_allowed',
    })
    expect(h.raw.specs).toEqual([])
  })

  test('a spec with external data is refused before anything is drawn', async () => {
    const h = harness()
    const outcome = await h.charts.execute({
      chatId: ALICE.id,
      spec: { ...spec(), data: { url: 'https://example.com/data.json' } },
    })
    expect(outcome).toEqual({
      status: 'invalid_spec',
      problem: 'external_resource',
      at: '/data/url',
    })
    expect(h.raw.specs).toEqual([])
    expect(h.scratch.created).toBe(0)
  })

  test('one chart at a time: a second request while drawing is refused as busy', async () => {
    const h = harness()
    let open: () => void = () => {}
    h.raw.gate = new Promise((resolve) => {
      open = resolve
    })
    const first = h.charts.execute({ chatId: ALICE.id, spec: spec() })
    expect(await h.charts.execute({ chatId: ALICE.id, spec: spec() })).toEqual({
      status: 'refused',
      reason: 'busy',
    })
    open()
    expect((await first).status).toBe('sent')
    expect((await h.charts.execute({ chatId: ALICE.id, spec: spec() })).status).toBe('sent')
  })

  test('renderer refusals and timeouts are reported, and the directory is removed', async () => {
    const h = harness()
    h.raw.failWith = new ChartRenderError('timeout')
    expect(await h.charts.execute({ chatId: ALICE.id, spec: spec() })).toEqual({
      status: 'not_rendered',
      reason: 'timeout',
      detail: undefined,
    })
    expect(h.images.sent).toEqual([])
    expect(h.scratch.live).toBe(0)
    expect(h.audit.entries.at(-1)).toMatchObject({
      event: 'chart.not_sent',
      details: { reason: 'timeout' },
    })
  })

  test('stop cancels the render in flight', async () => {
    const h = harness()
    let open: () => void = () => {}
    h.raw.gate = new Promise((resolve) => {
      open = resolve
    })
    const pending = h.charts.execute({ chatId: ALICE.id, spec: spec() })
    const stopped = h.charts.stop()
    open()
    await stopped
    expect((await pending).status).not.toBe('sent')
    expect(h.images.sent).toEqual([])
    expect(h.scratch.live).toBe(0)
  })

  test('a file that is not a PNG is not sent', async () => {
    const h = harness()
    h.raw.png = new Uint8Array([1, 2, 3])
    expect(await h.charts.execute({ chatId: ALICE.id, spec: spec() })).toMatchObject({
      status: 'failed',
      stage: 'render',
    })
    expect(h.images.sent).toEqual([])
  })
})
