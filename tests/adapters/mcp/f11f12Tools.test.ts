import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CHART_TOOL_NAME, MAX_CHART_CAPTION_LENGTH } from '../../../src/adapters/mcp/chartTool.ts'
import {
  CHANNEL_INSTRUCTIONS,
  McpChannelServer,
} from '../../../src/adapters/mcp/McpChannelServer.ts'
import {
  PROPOSE_MEMORY_TOOL_NAME,
  SAVE_SUMMARY_TOOL_NAME,
} from '../../../src/adapters/mcp/sessionMemoryTools.ts'
import type { ProposeMemoryOutcome } from '../../../src/application/use-cases/ProposeMemory.ts'
import type { SaveSummaryOutcome } from '../../../src/application/use-cases/SaveSessionSummary.ts'
import type { ChartOutcome } from '../../../src/application/use-cases/SendChart.ts'
import { MemoryLogger } from '../../fakes.ts'

const logger = new MemoryLogger()
let calls: { tool: string; request: unknown }[]
let chartOutcome: ChartOutcome | Error
let summaryOutcome: SaveSummaryOutcome
let proposeOutcome: ProposeMemoryOutcome
let server: McpChannelServer
let client: Client

beforeEach(async () => {
  calls = []
  chartOutcome = { status: 'sent', as: 'photo', bytes: 10, width: 800, height: 600, redactions: 0 }
  summaryOutcome = { status: 'saved', path: 'docs/sessions/x.md', notified: true }
  proposeOutcome = { status: 'proposed', proposalId: 'abcdefghij' }
  server = new McpChannelServer({
    name: 'telegram-bridge',
    version: '0.0.0-test',
    logger,
    reply: async () => ({ status: 'sent', parts: 1, redactions: 0 }),
    chart: async (request) => {
      calls.push({ tool: 'chart', request })
      if (chartOutcome instanceof Error) throw chartOutcome
      return chartOutcome
    },
    saveSummary: async (request) => {
      calls.push({ tool: 'summary', request })
      return summaryOutcome
    },
    proposeMemory: async (request) => {
      calls.push({ tool: 'memory', request })
      return proposeOutcome
    },
  })
  client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client.close()
  await server.close()
})

const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult
const text = (result: CallToolResult) => JSON.stringify(result.content)
const spec = { data: { values: [{ a: 1 }] }, mark: 'bar' }

test('the three tools are listed when wired', async () => {
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name)).toEqual([
    'reply',
    CHART_TOOL_NAME,
    SAVE_SUMMARY_TOOL_NAME,
    PROPOSE_MEMORY_TOOL_NAME,
  ])
})

test('not listed, and unknown, without handlers', async () => {
  const bare = new McpChannelServer({
    name: 'telegram-bridge',
    version: '0.0.0-test',
    logger,
    reply: async () => ({ status: 'sent', parts: 1, redactions: 0 }),
  })
  const bareClient = new Client({ name: 'test-client', version: '0.0.0' })
  const [c, s] = InMemoryTransport.createLinkedPair()
  await Promise.all([bare.connect(s), bareClient.connect(c)])
  const { tools } = await bareClient.listTools()
  expect(tools.map((t) => t.name)).toEqual(['reply'])
  await expect(
    bareClient.callTool({ name: CHART_TOOL_NAME, arguments: { chat_id: '1', spec } }),
  ).rejects.toThrow('Unknown tool')
  await bareClient.close()
  await bare.close()
})

test('the instructions explain the new tools', () => {
  expect(CHANNEL_INSTRUCTIONS).toContain('send_chart')
  expect(CHANNEL_INSTRUCTIONS).toContain('save_session_summary')
  expect(CHANNEL_INSTRUCTIONS).toContain('propose_memory')
  expect(CHANNEL_INSTRUCTIONS).toContain('kind="memory"')
})

describe('send_chart', () => {
  test('passes the spec and the caption through', async () => {
    const result = await call(CHART_TOOL_NAME, { chat_id: '42', spec, caption: 'Q3' })
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('800x600')
    expect(calls).toEqual([{ tool: 'chart', request: { chatId: '42', spec, caption: 'Q3' } }])
  })

  test.each([
    [{ chat_id: '42' }],
    [{ chat_id: '42', spec: 'not an object' }],
    [{ chat_id: '42', spec: [1, 2] }],
    [{ chat_id: '', spec }],
    [{ chat_id: '42', spec, caption: 'x'.repeat(MAX_CHART_CAPTION_LENGTH + 1) }],
  ])('invalid arguments never reach the use case', async (args) => {
    expect((await call(CHART_TOOL_NAME, args)).isError).toBe(true)
    expect(calls).toEqual([])
  })

  test('refusals and failures are tool errors with a hint; crashes hide the error', async () => {
    chartOutcome = { status: 'invalid_spec', problem: 'external_resource', at: '/data/url' }
    const invalid = await call(CHART_TOOL_NAME, { chat_id: '42', spec })
    expect(invalid.isError).toBe(true)
    expect(text(invalid)).toContain('/data/url')
    expect(text(invalid)).toContain('inline')
    chartOutcome = { status: 'refused', reason: 'busy' }
    expect(text(await call(CHART_TOOL_NAME, { chat_id: '42', spec }))).toContain('another chart')
    chartOutcome = { status: 'not_rendered', reason: 'timeout', detail: undefined }
    expect(text(await call(CHART_TOOL_NAME, { chat_id: '42', spec }))).toContain('too long')
    chartOutcome = new Error('kaboom')
    const crashed = await call(CHART_TOOL_NAME, { chat_id: '42', spec })
    expect(crashed.isError).toBe(true)
    expect(text(crashed)).not.toContain('kaboom')
  })
})

describe('save_session_summary', () => {
  test('returns the relative path', async () => {
    const result = await call(SAVE_SUMMARY_TOOL_NAME, {
      chat_id: '42',
      title: 'T',
      markdown: '# T',
    })
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('docs/sessions/x.md')
    expect(calls).toEqual([
      { tool: 'summary', request: { chatId: '42', title: 'T', markdown: '# T' } },
    ])
  })

  test('problems are tool errors', async () => {
    summaryOutcome = { status: 'not_saved', problem: 'outside_project' }
    const result = await call(SAVE_SUMMARY_TOOL_NAME, { chat_id: '42', title: 'T', markdown: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('outside the project')
    expect((await call(SAVE_SUMMARY_TOOL_NAME, { chat_id: '42', title: 'T' })).isError).toBe(true)
  })
})

describe('propose_memory', () => {
  test('returns the proposal id at once', async () => {
    const result = await call(PROPOSE_MEMORY_TOOL_NAME, { chat_id: '42', lines: ['a', 'b'] })
    expect(text(result)).toContain('proposal_id=abcdefghij')
    expect(text(result)).toContain('kind=\\"memory\\"')
    expect(calls).toEqual([{ tool: 'memory', request: { chatId: '42', lines: ['a', 'b'] } }])
  })

  test('a line with a secret or that does not fit is a tool error, with the line number', async () => {
    proposeOutcome = { status: 'invalid', problem: 'contains_secret' }
    const secret = await call(PROPOSE_MEMORY_TOOL_NAME, { chat_id: '42', lines: ['a'] })
    expect(secret.isError).toBe(true)
    expect(text(secret)).toContain('secret')
    proposeOutcome = { status: 'invalid', problem: 'line_too_long', line: 3 }
    expect(text(await call(PROPOSE_MEMORY_TOOL_NAME, { chat_id: '42', lines: ['a'] }))).toContain(
      '(line 3)',
    )
    proposeOutcome = { status: 'refused', reason: 'not_polling' }
    expect((await call(PROPOSE_MEMORY_TOOL_NAME, { chat_id: '42', lines: ['a'] })).isError).toBe(
      true,
    )
  })

  test('lines must be an array of strings', async () => {
    expect((await call(PROPOSE_MEMORY_TOOL_NAME, { chat_id: '42', lines: 'a' })).isError).toBe(true)
    expect((await call(PROPOSE_MEMORY_TOOL_NAME, { chat_id: '42', lines: [1] })).isError).toBe(true)
    expect(calls).toEqual([])
  })
})
