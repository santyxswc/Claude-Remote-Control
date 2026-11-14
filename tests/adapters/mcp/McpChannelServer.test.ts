import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  type CallToolResult,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js'
import {
  ASK_CHOICE_TOOL_NAME,
  CHANNEL_INSTRUCTIONS,
  InvalidChannelMetaError,
  MAX_CHOICE_QUESTION_LENGTH,
  MAX_PERMISSION_FIELD_LENGTH,
  MAX_REPLY_TEXT_LENGTH,
  McpChannelServer,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
  SCREENSHOT_TOOL_NAME,
} from '../../../src/adapters/mcp/McpChannelServer.ts'
import type {
  AskChoiceOutcome,
  AskChoiceRequest,
} from '../../../src/application/use-cases/AskChoice.ts'
import type {
  CaptureOutcome,
  CaptureRequest,
} from '../../../src/application/use-cases/CaptureScreenshot.ts'
import type { IncomingPermissionRequest } from '../../../src/application/use-cases/RelayPermissionRequest.ts'
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

  test('does not declare permission relay unless enabled', () => {
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

  test('L2: a text over 64 KiB is an error result and never reaches the use case', async () => {
    expect(MAX_REPLY_TEXT_LENGTH).toBe(65_536)
    const ok = await callTool('reply', { chat_id: '42', text: 'a'.repeat(MAX_REPLY_TEXT_LENGTH) })
    expect(ok.isError).toBeFalsy()
    const result = await callTool('reply', {
      chat_id: '42',
      text: 'a'.repeat(MAX_REPLY_TEXT_LENGTH + 1),
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('65536')
    expect(requests).toHaveLength(1)
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

describe('permission relay', () => {
  let relayServer: McpChannelServer
  let relayClient: Client
  let relayLogger: MemoryLogger
  let received: IncomingPermissionRequest[]
  let wire: { method: string; params?: unknown }[]

  beforeEach(async () => {
    relayLogger = new MemoryLogger()
    received = []
    wire = []
    relayServer = new McpChannelServer({
      name: 'telegram-bridge',
      version: '0.0.0-test',
      logger: relayLogger,
      reply: async () => ({ status: 'sent', parts: 1, redactions: 0 }),
      permissionRelay: true,
    })
    relayServer.onPermissionRequest(async (request) => void received.push(request))
    relayClient = new Client({ name: 'fake-claude-code', version: '0.0.0' })
    relayClient.fallbackNotificationHandler = async (n) => void wire.push(n)
    const [c, s] = InMemoryTransport.createLinkedPair()
    await Promise.all([relayServer.connect(s), relayClient.connect(c)])
  })

  afterEach(async () => {
    await relayClient.close()
    await relayServer.close()
  })

  const ask = (params: unknown) =>
    relayClient.notification({ method: PERMISSION_REQUEST_METHOD, params } as never)

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Bun.sleep(1)
  }

  test('declares claude/channel/permission when enabled', () => {
    expect(relayClient.getServerCapabilities()?.experimental).toEqual({
      'claude/channel': {},
      'claude/channel/permission': {},
    })
  })

  test('hands a valid permission_request to the handler', async () => {
    await ask({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'List files',
      input_preview: '{"command":"ls"}',
    })
    await settle()
    expect(received).toEqual([
      {
        requestId: 'abcde',
        toolName: 'Bash',
        description: 'List files',
        inputPreview: '{"command":"ls"}',
      },
    ])
  })

  test.each([
    [{ request_id: 'abcdl', tool_name: 'Bash', description: '', input_preview: '' }],
    [{ request_id: 'ABCDE', tool_name: 'Bash', description: '', input_preview: '' }],
    [{ request_id: 'abcde', tool_name: '', description: '', input_preview: '' }],
    [{ request_id: 'abcde', tool_name: 'Bash', description: 1, input_preview: '' }],
    [{ request_id: 'abcde', tool_name: 'Bash', description: '' }],
    [undefined],
  ])('ignores and logs a malformed request %#, without its values', async (params) => {
    await ask(params)
    await settle()
    expect(received).toEqual([])
    expect(relayLogger.text).toContain('ignored a malformed permission request')
    expect(relayLogger.text).not.toContain('abcdl')
    expect(relayLogger.text).not.toContain('ABCDE')
  })

  test('L2: a field the size Claude Code can send (3,500 astral code points) is accepted', async () => {
    const preview = '\u{1F600}'.repeat(3_500)
    await ask({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: preview,
      input_preview: preview,
    })
    await settle()
    expect(received).toHaveLength(1)
  })

  test('L2: a field longer than Claude Code ever sends is ignored and logged', async () => {
    expect(MAX_PERMISSION_FIELD_LENGTH).toBe(8_192)
    await ask({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: '',
      input_preview: 'x'.repeat(MAX_PERMISSION_FIELD_LENGTH + 1),
    })
    await settle()
    expect(received).toEqual([])
    expect(relayLogger.text).toContain('ignored a malformed permission request')
  })

  test('sendVerdict emits notifications/claude/channel/permission', async () => {
    await relayServer.sendVerdict('abcde', 'allow')
    await relayServer.sendVerdict('fghij', 'deny')
    await settle()
    expect(wire).toEqual([
      {
        method: PERMISSION_VERDICT_METHOD,
        params: { request_id: 'abcde', behavior: 'allow' },
        jsonrpc: '2.0',
      },
      {
        method: PERMISSION_VERDICT_METHOD,
        params: { request_id: 'fghij', behavior: 'deny' },
        jsonrpc: '2.0',
      },
    ] as never)
  })

  test('refuses to send a malformed verdict', async () => {
    await expect(relayServer.sendVerdict('abcdl', 'allow')).rejects.toThrow()
    await expect(relayServer.sendVerdict('abcde', 'maybe' as never)).rejects.toThrow()
  })

  test('without a handler, requests are ignored', async () => {
    const lone = new McpChannelServer({
      name: 'x',
      version: '0',
      logger: relayLogger,
      reply: async () => ({ status: 'sent', parts: 1, redactions: 0 }),
      permissionRelay: true,
    })
    const client2 = new Client({ name: 'c', version: '0' })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await Promise.all([lone.connect(s), client2.connect(c)])
    await client2.notification({
      method: PERMISSION_REQUEST_METHOD,
      params: { request_id: 'abcde', tool_name: 'Bash', description: '', input_preview: '' },
    } as never)
    await settle()
    expect(relayLogger.text).toContain('the relay is not ready')
    await client2.close()
    await lone.close()
  })
})

describe('send_screenshot tool', () => {
  let shots: CaptureRequest[]
  let shotOutcome: CaptureOutcome | Error
  let shotServer: McpChannelServer
  let shotClient: Client

  beforeEach(async () => {
    shots = []
    shotOutcome = { status: 'sent', as: 'photo', bytes: 1234 }
    shotServer = new McpChannelServer({
      name: 'telegram-bridge',
      version: '0.0.0-test',
      logger,
      reply: async () => ({ status: 'sent', parts: 1, redactions: 0 }),
      screenshot: async (request) => {
        shots.push(request)
        if (shotOutcome instanceof Error) throw shotOutcome
        return shotOutcome
      },
    })
    shotClient = new Client({ name: 'test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([shotServer.connect(serverTransport), shotClient.connect(clientTransport)])
  })

  afterEach(async () => {
    await shotClient.close()
    await shotServer.close()
  })

  const shoot = async (args: Record<string, unknown>) =>
    (await shotClient.callTool({ name: SCREENSHOT_TOOL_NAME, arguments: args })) as CallToolResult

  test('is listed only when a screenshot handler is wired', async () => {
    const { tools } = await shotClient.listTools()
    expect(tools.map((t) => t.name)).toEqual(['reply', 'send_screenshot'])
    expect(tools[1]).toMatchObject({
      inputSchema: {
        type: 'object',
        properties: { chat_id: { type: 'string' }, url: { type: 'string' } },
        required: ['chat_id'],
      },
    })
    await expect(callTool(SCREENSHOT_TOOL_NAME, { chat_id: '1' })).rejects.toThrow('Unknown tool')
  })

  test('hands chat_id and url to the use case as the session', async () => {
    expect(await shoot({ chat_id: '42' })).toEqual({
      content: [{ type: 'text', text: 'sent as a photo (1234 bytes, not redacted)' }],
    })
    await shoot({ chat_id: '42', url: 'localhost:3000' })
    expect(shots).toEqual([
      { chatId: '42', actor: 'session' },
      { chatId: '42', actor: 'session', url: 'localhost:3000' },
    ])
  })

  test.each([
    [{ status: 'refused', reason: 'chat_not_allowed' }, 'not the chat of a paired user'],
    [{ status: 'refused', reason: 'busy' }, 'another screenshot is being taken'],
    [{ status: 'invalid_url', problem: 'scheme' }, 'http:// or https://'],
    [
      {
        status: 'unavailable',
        kind: 'url',
        detail: { reason: 'no_browser', remedies: ['chromium'] },
      },
      'cannot capture web pages (no_browser). The user can enable it with: chromium.',
    ],
    [{ status: 'too_large', bytes: 60_000_000 }, '50 MB'],
    [
      { status: 'failed', stage: 'send', error: 'Bad Request' },
      'while trying to send: Bad Request',
    ],
  ] as const)('%p is an error result', async (outcome, text) => {
    shotOutcome = outcome
    const result = await shoot({ chat_id: '42' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(text)
  })

  test('bad arguments and a crashing handler are error results', async () => {
    expect((await shoot({})).isError).toBe(true)
    expect((await shoot({ chat_id: '42', url: 7 })).isError).toBe(true)
    expect(shots).toEqual([])
    shotOutcome = new Error('boom')
    expect(await shoot({ chat_id: '42' })).toEqual({
      content: [{ type: 'text', text: 'Screenshot failed: internal error' }],
      isError: true,
    })
  })

  test('the instructions mention the tool and that images are not redacted', () => {
    expect(CHANNEL_INSTRUCTIONS).toContain('send_screenshot')
    expect(CHANNEL_INSTRUCTIONS).toContain('Images are not redacted')
  })
})

describe('ask_choice', () => {
  let asks: AskChoiceRequest[]
  let askOutcome: AskChoiceOutcome | Error
  let askServer: McpChannelServer
  let askClient: Client

  beforeEach(async () => {
    asks = []
    askOutcome = { status: 'asked', choiceId: 'abcdefghij' }
    askServer = new McpChannelServer({
      name: 'telegram-bridge',
      version: '0.0.0-test',
      logger,
      reply: async () => ({ status: 'sent', parts: 1, redactions: 0 }),
      askChoice: async (request) => {
        asks.push(request)
        if (askOutcome instanceof Error) throw askOutcome
        return askOutcome
      },
    })
    askClient = new Client({ name: 'test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([askServer.connect(serverTransport), askClient.connect(clientTransport)])
  })

  afterEach(async () => {
    await askClient.close()
    await askServer.close()
  })

  const ask = async (args: Record<string, unknown>) =>
    (await askClient.callTool({ name: ASK_CHOICE_TOOL_NAME, arguments: args })) as CallToolResult
  const valid = { chat_id: '42', question: 'Which?', options: ['A', 'B'] }

  test('is listed only when a handler is wired', async () => {
    const { tools } = await askClient.listTools()
    expect(tools.map((t) => t.name)).toEqual(['reply', ASK_CHOICE_TOOL_NAME])
    expect(tools[1]).toMatchObject({
      inputSchema: { required: ['chat_id', 'question', 'options'] },
    })
    await expect(callTool(ASK_CHOICE_TOOL_NAME, valid)).rejects.toThrow('Unknown tool')
  })

  test('returns the choice id at once and passes the arguments through', async () => {
    const result = await ask({ ...valid, allow_other: true })
    expect(result.isError).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('choice_id=abcdefghij')
    await ask(valid)
    expect(asks).toEqual([
      { chatId: '42', question: 'Which?', options: ['A', 'B'], allowOther: true },
      { chatId: '42', question: 'Which?', options: ['A', 'B'], allowOther: false },
    ])
  })

  test.each([
    [{ ...valid, options: ['A'] }],
    [{ ...valid, options: Array.from({ length: 9 }, (_, i) => `${i}`) }],
    [{ ...valid, question: '' }],
    [{ ...valid, question: 'x'.repeat(MAX_CHOICE_QUESTION_LENGTH + 1) }],
    [{ ...valid, options: 'A,B' }],
    [{ question: 'q', options: ['a', 'b'] }],
  ])('invalid arguments never reach the use case', async (args) => {
    const result = await ask(args)
    expect(result.isError).toBe(true)
    expect(asks).toEqual([])
  })

  test('refusals, problems and crashes are tool errors', async () => {
    askOutcome = { status: 'refused', reason: 'chat_not_allowed' }
    expect((await ask(valid)).isError).toBe(true)
    askOutcome = { status: 'invalid', problem: 'duplicate_option' }
    expect(JSON.stringify((await ask(valid)).content)).toContain('distinct')
    askOutcome = new Error('kaboom')
    const crashed = await ask(valid)
    expect(crashed.isError).toBe(true)
    expect(JSON.stringify(crashed.content)).not.toContain('kaboom')
  })

  test('the instructions explain choices and attachments', () => {
    expect(CHANNEL_INSTRUCTIONS).toContain('kind="choice"')
    expect(CHANNEL_INSTRUCTIONS).toContain('kind="attachment"')
  })
})
