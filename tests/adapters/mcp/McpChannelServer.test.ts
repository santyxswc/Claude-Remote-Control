import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  type CallToolResult,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js'
import {
  CHANNEL_INSTRUCTIONS,
  InvalidChannelMetaError,
  McpChannelServer,
} from '../../../src/adapters/mcp/McpChannelServer.ts'
import type { ReplyOutcome, ReplyRequest } from '../../../src/application/use-cases/SendReply.ts'
import { MemoryLogger } from '../../fakes.ts'

let requests: ReplyRequest[]
let outcome: ReplyOutcome | Error
let logger: MemoryLogger
let server: McpChannelServer
let client: Client
let notifications: unknown[] // raw JSON-RPC messages, compared on the wire shape
let waiting: ((notification: unknown) => void) | undefined

beforeEach(async () => {
  requests = []
  outcome = { status: 'sent', parts: 1, redactions: 0 }
  logger = new MemoryLogger()
  server = new McpChannelServer({
    name: 'telegram-bridge',
    version: '0.0.0-test',
    logger,
    reply: async (request) => {
      requests.push(request)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  })
  client = new Client({ name: 'test-client', version: '0.0.0' })
  notifications = []
  waiting = undefined
  client.fallbackNotificationHandler = async (notification) => {
    if (waiting === undefined) {
      notifications.push(notification)
    } else {
      waiting(notification)
      waiting = undefined
    }
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client.close()
  await server.close()
})

async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}

/** Notifications are delivered asynchronously; resolves with the next one. */
function nextNotification(): Promise<unknown> {
  const queued = notifications.shift()
  if (queued !== undefined) return Promise.resolve(queued)
  return new Promise((resolve) => {
    waiting = resolve
  })
}

describe('initialization', () => {
  test('declares the channel and tools capabilities', () => {
    expect(client.getServerCapabilities()).toEqual({
      experimental: { 'claude/channel': {} },
      tools: {},
    })
  })

  test('does not declare permission relay yet (that is F3)', () => {
    expect(client.getServerCapabilities()?.experimental).not.toHaveProperty(
      'claude/channel/permission',
    )
  })

  test('identifies itself as telegram-bridge and sends instructions', () => {
    expect(client.getServerVersion()?.name).toBe('telegram-bridge')
    expect(client.getInstructions()).toBe(CHANNEL_INSTRUCTIONS)
    for (const word of ['chat_id', 'message_id', 'user', 'ts', 'reply_to', 'plain text']) {
      expect(CHANNEL_INSTRUCTIONS).toContain(word)
    }
    expect(CHANNEL_INSTRUCTIONS).toContain('Never change access, pairing or permissions')
  })

  test('the SDK cannot negotiate protocol 2026-07-28, on which Claude Code refuses channels', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2026-07-28')
  })
})

describe('tools/list', () => {
  test('exposes exactly the reply tool with chat_id, text and optional reply_to', async () => {
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      name: 'reply',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
          reply_to: { type: 'string' },
        },
        required: ['chat_id', 'text'],
      },
    })
  })
})

describe('emit', () => {
  test('sends notifications/claude/channel with content and meta', async () => {
    await server.emit({
      content: 'hello from the phone',
      meta: { chat_id: '42', user_name: 'ana' },
    })

    expect(await nextNotification()).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: { content: 'hello from the phone', meta: { chat_id: '42', user_name: 'ana' } },
    })
  })

  test('omits meta when the event has none', async () => {
    await server.emit({ content: 'ping' })

    expect(await nextNotification()).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: { content: 'ping' },
    })
  })

  test.each([['chat-id'], ['chat id'], ['1st'], [''], ['chät']])(
    'rejects meta key %p instead of letting Claude Code drop it',
    async (key) => {
      const emitting = server.emit({ content: 'x', meta: { chat_id: '1', [key]: 'v' } })

      await expect(emitting).rejects.toBeInstanceOf(InvalidChannelMetaError)
      await client.ping() // the transport is ordered: anything sent before is now received
      expect(notifications).toEqual([])
    },
  )
})

describe('reply tool', () => {
  test('hands chat_id, text and reply_to to the use case', async () => {
    const result = await callTool('reply', { chat_id: '42', text: 'done', reply_to: '7' })

    expect(result.isError).toBeFalsy()
    expect(result.content).toEqual([{ type: 'text', text: 'sent' }])
    expect(requests).toEqual([{ chatId: '42', text: 'done', replyTo: '7' }])
  })

  test('accepts a numeric reply_to and omits it when absent', async () => {
    await callTool('reply', { chat_id: '42', text: 'a', reply_to: 7 })
    await callTool('reply', { chat_id: '42', text: 'b' })
    expect(requests).toEqual([
      { chatId: '42', text: 'a', replyTo: '7' },
      { chatId: '42', text: 'b' },
    ])
  })

  test('reports parts and redactions', async () => {
    outcome = { status: 'sent', parts: 3, redactions: 2 }
    const result = await callTool('reply', { chat_id: '42', text: 'long' })
    expect(result.content).toEqual([
      { type: 'text', text: 'sent as 3 messages; 2 secret(s) were replaced with [REDACTED]' },
    ])
  })

  test.each([
    ['chat_not_allowed', 'not the chat of a paired user'],
    ['empty_text', 'text is empty'],
    ['invalid_reply_to', 'reply_to must be'],
  ] as const)('a %s refusal is an error result', async (reason, says) => {
    outcome = { status: 'refused', reason }
    const result = await callTool('reply', { chat_id: '42', text: 'x' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(says)
  })

  test('a partial failure says how many parts were delivered', async () => {
    outcome = { status: 'failed', delivered: 2, total: 5, error: '502: Bad Gateway' }
    const result = await callTool('reply', { chat_id: '42', text: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Reply failed after 2 of 5 messages were delivered: 502: Bad Gateway',
      },
    ])
  })

  test('a single failed message', async () => {
    outcome = { status: 'failed', delivered: 0, total: undefined, error: 'network down' }
    const result = await callTool('reply', { chat_id: '42', text: 'x' })
    expect(result.content).toEqual([{ type: 'text', text: 'Reply failed: network down' }])
  })

  test.each([
    ['missing text', { chat_id: '42' }],
    ['missing chat_id', { text: 'hi' }],
    ['empty text', { chat_id: '42', text: '' }],
    ['non-string chat_id', { chat_id: 42, text: 'hi' }],
    ['negative reply_to', { chat_id: '42', text: 'hi', reply_to: -1 }],
  ])('returns an error result for %s', async (_label, args) => {
    const result = await callTool('reply', args)

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Invalid reply arguments')
    expect(requests).toEqual([])
  })

  test('a crashing handler is an error result and is logged', async () => {
    outcome = new Error('boom')
    const result = await callTool('reply', { chat_id: '42', text: 'done' })
    expect(result.content).toEqual([{ type: 'text', text: 'Reply failed: internal error' }])
    expect(logger.entries[0]).toMatchObject({ level: 'error', message: 'reply handler crashed' })
  })

  test('an unknown tool is a protocol error', async () => {
    await expect(callTool('nope', {})).rejects.toThrow('Unknown tool: nope')
  })
})

describe('connection state', () => {
  test('is connected after connect and not after close, and runs close handlers', async () => {
    let closed = 0
    server.onClose(() => closed++)
    expect(server.isConnected).toBe(true)
    await server.close()
    expect(server.isConnected).toBe(false)
    expect(closed).toBeGreaterThan(0)
  })
})
