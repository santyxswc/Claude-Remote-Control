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
import { FakeChatGateway, MemoryLogger } from '../../fakes.ts'

let chat: FakeChatGateway
let logger: MemoryLogger
let server: McpChannelServer
let client: Client
let notifications: unknown[] // raw JSON-RPC messages, compared on the wire shape
let waiting: ((notification: unknown) => void) | undefined

beforeEach(async () => {
  chat = new FakeChatGateway()
  logger = new MemoryLogger()
  server = new McpChannelServer({ name: 'telegram-bridge', version: '0.0.0-test', chat, logger })
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
    expect(CHANNEL_INSTRUCTIONS).toContain('chat_id')
  })

  test('the SDK cannot negotiate protocol 2026-07-28, on which Claude Code refuses channels', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2026-07-28')
  })
})

describe('tools/list', () => {
  test('exposes exactly the reply tool with chat_id and text', async () => {
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      name: 'reply',
      inputSchema: {
        type: 'object',
        properties: { chat_id: { type: 'string' }, text: { type: 'string' } },
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
  test('forwards the message to the chat gateway', async () => {
    const result = await callTool('reply', { chat_id: '42', text: 'done' })

    expect(result.isError).toBeFalsy()
    expect(result.content).toEqual([{ type: 'text', text: 'sent' }])
    expect(chat.sent).toEqual([{ chatId: '42', text: 'done' }])
  })

  test.each([
    ['missing text', { chat_id: '42' }],
    ['missing chat_id', { text: 'hi' }],
    ['empty text', { chat_id: '42', text: '' }],
    ['non-string chat_id', { chat_id: 42, text: 'hi' }],
  ])('returns an error result for %s', async (_label, args) => {
    const result = await callTool('reply', args)

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(result.content)).toContain('Invalid reply arguments')
    expect(chat.sent).toEqual([])
  })

  test('returns an error result and logs when the gateway fails', async () => {
    chat.failWith = new Error('network down')

    const result = await callTool('reply', { chat_id: '42', text: 'done' })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Reply failed: network down' }])
    expect(logger.entries).toHaveLength(1)
    expect(logger.entries[0]).toMatchObject({ level: 'error', message: 'reply failed' })
  })

  test('an unknown tool is a protocol error', async () => {
    await expect(callTool('nope', {})).rejects.toThrow('Unknown tool: nope')
  })
})
