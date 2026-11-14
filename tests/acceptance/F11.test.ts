/**
 * F11 acceptance: `send_chart`. The real composition (MCP server over an
 * in-memory transport, SQLite state, the outbound decorators and the real
 * chart renderer process) against an in-process fake of the Bot API. An MCP
 * client stands in for Claude Code. Everything lives in temp directories.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ProcessChartRenderer } from '../../src/adapters/chart/ProcessChartRenderer.ts'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import { McpChannelServer } from '../../src/adapters/mcp/McpChannelServer.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import { buildCharts } from '../../src/composition/charts.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { readPngSize } from '../../src/domain/capture/pngSize.ts'
import { FakeClock, MemoryLogger } from '../fakes.ts'
import { FakeTelegramApi, PHONE_OWNER, STRANGER, TEST_TOKEN } from '../fakeTelegram.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`
const RENDER_TIMEOUT_MS = 30_000

let stateDir: string
let state: StateStores
let server: McpChannelServer
let client: Client
let api: FakeTelegramApi
let memory: MemoryLogger

beforeEach(async () => {
  stateDir = makeTempDir()
  const clock = new FakeClock()
  api = new FakeTelegramApi()
  memory = new MemoryLogger()
  state = openState(stateDir, {}, clock)
  state.allowed.add(
    allowSender({ id: OWNER_ID, username: 'owner', displayName: 'Owner' }, clock.now()),
  )
  const logger = new RedactingLogger(memory, [TEST_TOKEN])
  const outbound = buildOutbound({
    token: TEST_TOKEN,
    dev: undefined,
    literalSecrets: [],
    fetch: api.fetch,
    charts: new ProcessChartRenderer(),
  })
  const charts = buildCharts({ stateDir, state, outbound, messages: en, clock, logger })
  const sendReply = buildSendReply({ state, chat: outbound, extraChatIds: [], clock, logger })
  server = new McpChannelServer({
    name: 'telegram-bridge',
    version: '0.0.0-test',
    reply: (request) => sendReply.execute(request),
    logger,
    chart: (request) => charts.execute(request),
  })
  client = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
})

afterEach(async () => {
  await client.close()
  await server.close()
  state.db.close()
  removeTempDir(stateDir)
})

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }

async function sendChart(args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: 'send_chart', arguments: args })) as ToolResult
}

const spec = (title: string) => ({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  title,
  data: {
    values: [
      { mes: 'Enero', ventas: 28 },
      { mes: 'Febrero', ventas: 55 },
    ],
  },
  mark: 'bar',
  encoding: {
    x: { field: 'mes', type: 'nominal' },
    y: { field: 'ventas', type: 'quantitative' },
  },
})

const audit = () =>
  state.db
    .query<{ event: string; details: string }, []>(
      'SELECT event, details FROM audit_log ORDER BY seq',
    )
    .all()

test(
  'Claude sends a chart: a real PNG reaches the chat as a photo, with a redacted caption',
  async () => {
    const result = await sendChart({
      chat_id: OWNER_ID,
      spec: spec('Ventas del trimestre'),
      caption: `Q1 (token ${GITHUB_TOKEN})`,
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toMatch(/^sent as a photo \(\d+x\d+ px, \d+ bytes\)$/)
    const photos = api.callsTo('sendPhoto')
    expect(photos).toHaveLength(1)
    expect(photos[0]?.payload.chat_id).toBe(OWNER_ID)
    expect(photos[0]?.payload.caption).not.toContain(GITHUB_TOKEN)
    expect(photos[0]?.payload.caption).toContain('[REDACTED]')
    const upload = api.uploads[0]
    expect(upload?.filename).toBe('chart.png')
    const size = readPngSize(upload?.bytes ?? new Uint8Array())
    expect(size?.width).toBeGreaterThan(100)
    expect(size?.height).toBeGreaterThan(100)
    // The scratch directory is gone, and the audit row has sizes only.
    expect(readdirSync(join(stateDir, 'tmp'))).toEqual([])
    const rows = audit().filter((r) => r.event === 'chart.sent')
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(audit())).not.toContain('Ventas')
    expect(JSON.stringify(audit())).not.toContain('Q1')
  },
  RENDER_TIMEOUT_MS,
)

test(
  'a secret in the spec is redacted before drawing and the tool says so',
  async () => {
    const result = await sendChart({ chat_id: OWNER_ID, spec: spec(`key ${GITHUB_TOKEN}`) })
    expect(result.content[0]?.text).toContain('1 string(s) in the spec were replaced')
    expect(api.callsTo('sendPhoto')).toHaveLength(1)
    expect(JSON.stringify(memory.entries)).not.toContain(GITHUB_TOKEN)
  },
  RENDER_TIMEOUT_MS,
)

test('external data, image marks and full Vega specs are refused before drawing', async () => {
  for (const bad of [
    { ...spec('x'), data: { url: 'https://example.com/data.csv' } },
    { ...spec('x'), data: { url: '../../.env' } },
    { ...spec('x'), mark: 'image' },
    { $schema: 'https://vega.github.io/schema/vega/v6.json', marks: [] },
  ]) {
    const result = await sendChart({ chat_id: OWNER_ID, spec: bad })
    expect(result.isError).toBe(true)
  }
  expect(api.callsTo('sendPhoto')).toEqual([])
  expect(audit().filter((r) => r.event === 'chart.not_sent')).toHaveLength(4)
})

test('only the chat of a paired user', async () => {
  const result = await sendChart({ chat_id: String(STRANGER.id), spec: spec('x') })
  expect(result.isError).toBe(true)
  expect(result.content[0]?.text).toContain('paired user')
  expect(api.callsTo('sendPhoto')).toEqual([])
})
