/**
 * F9 acceptance: the pinned status message, fed by hooks. The real
 * composition (MCP server over an in-memory transport, SQLite state, grammY
 * poller, inbound chain, outbound decorators, the status updater on its own
 * timer) against an in-process fake of the Bot API. Hook events are handed
 * to the listener directly; the clock is fake and the timer ticked by hand.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import { McpChannelServer } from '../../src/adapters/mcp/McpChannelServer.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import type {
  HookEventSource,
  HookPayloadHandler,
} from '../../src/application/ports/HookEventSource.ts'
import { createSessionTracking } from '../../src/composition/hooks.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import { STATUS_TICK_MS } from '../../src/composition/statusMessage.ts'
import {
  startTelegramInbound,
  type TelegramInbound,
} from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { REDACTION_MARK } from '../../src/domain/redaction/SecretRedactor.ts'
import { STATUS_MIN_INTERVAL_MS } from '../../src/domain/status/StatusUpdatePolicy.ts'
import { FakeClock, ManualEvery, MemoryLogger } from '../fakes.ts'
import { FakeTelegramApi, PHONE_OWNER, STRANGER, TEST_TOKEN } from '../fakeTelegram.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`

let stateDir: string
let state: StateStores
let inbound: TelegramInbound | undefined
let server: McpChannelServer
let client: Client
let api: FakeTelegramApi
let clock: FakeClock
let timers: ManualEvery
let hookHandler: HookPayloadHandler | undefined

async function start(): Promise<void> {
  const logger = new RedactingLogger(new MemoryLogger(), [TEST_TOKEN])
  const chat = buildOutbound({
    token: TEST_TOKEN,
    dev: undefined,
    literalSecrets: [],
    fetch: api.fetch,
  })
  const sendReply = buildSendReply({ state, chat, extraChatIds: [], clock, logger })
  server = new McpChannelServer({
    name: 'telegram-bridge',
    version: '0.0.0-test',
    reply: (request) => sendReply.execute(request),
    logger,
    permissionRelay: true,
  })
  client = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  client.fallbackNotificationHandler = async () => {}
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  hookHandler = undefined
  const hooks: HookEventSource = {
    start: async (handler) => {
      hookHandler = handler
      return 'listening'
    },
    stop: async () => {
      hookHandler = undefined
    },
  }
  timers = new ManualEvery()
  inbound = startTelegramInbound({
    state,
    token: TEST_TOKEN,
    chat,
    channel: server,
    messages: en,
    clock,
    logger,
    fetch: api.fetch,
    pollTimeoutSeconds: 1,
    tracking: createSessionTracking(clock),
    hooks,
    every: timers.every,
    session: 'this-session',
    project: 'my-app',
  })
  await api.waitForPolls(1)
  await until(() => hookHandler !== undefined, 'the hook listener')
}

async function stop(): Promise<void> {
  await inbound?.stop()
  inbound = undefined
  await client.close()
  await server.close()
}

beforeEach(() => {
  stateDir = makeTempDir()
  clock = new FakeClock()
  api = new FakeTelegramApi()
  inbound = undefined
  state = openState(stateDir, {}, clock)
  state.identities.save({ id: '123456789', username: 'test_bot' })
  state.allowed.add(
    allowSender({ id: OWNER_ID, username: 'owner', displayName: 'Owner' }, clock.now()),
  )
})

afterEach(async () => {
  if (inbound !== undefined) await stop()
  state.db.close()
  removeTempDir(stateDir)
})

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

/** Lets every request already started reach the fake API. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Bun.sleep(1)
}

/** `seconds` of status timer ticks, the clock moving with them. */
async function tick(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    clock.advance(STATUS_TICK_MS)
    timers.tick(STATUS_TICK_MS)
    await settle()
  }
}

async function hook(payload: Record<string, unknown>): Promise<void> {
  await hookHandler?.({ session_id: 's1', cwd: '/home/owner/my-app', ...payload })
}

const sends = () => api.callsTo('sendMessage')
/** The status messages sent (silent ones); notices and replies are not. */
const statusSends = () => sends().filter((c) => c.payload.disable_notification === true)
const edits = () => api.callsTo('editMessageText').map((c) => c.payload)
const pins = () => api.callsTo('pinChatMessage').map((c) => c.payload)

async function pinned(): Promise<number> {
  api.sendText(PHONE_OWNER, '/pin')
  await until(() => pins().length === 1, 'the pin')
  const id = pins()[0]?.message_id
  if (id === undefined) throw new Error('no pin')
  // Past the per-chat interval, so the next change can go out.
  clock.advance(STATUS_MIN_INTERVAL_MS)
  return id
}

test('/pin sends the status silently and pins it; the id is stored', async () => {
  await start()
  const id = await pinned()
  const sent = sends()[0]?.payload
  expect(sent?.chat_id).toBe(OWNER_ID)
  expect(sent?.disable_notification).toBe(true)
  expect(sent?.reply_markup).toBeUndefined()
  expect(sent?.text).toBe('📌 Claude Code · my-app\nState: unknown (no hook events yet)')
  expect(pins()[0]).toMatchObject({ chat_id: OWNER_ID, message_id: id, disable_notification: true })
  expect(state.statusMessages.find(OWNER_ID)).toEqual({ chatId: OWNER_ID, messageId: String(id) })
  // No other reply: the status message is the answer.
  expect(sends()).toHaveLength(1)
})

test('hook events become one coalesced edit; an unchanged render never edits', async () => {
  await start()
  const id = await pinned()
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: `use ${GITHUB_TOKEN}` })
  for (const file of ['a.ts', 'b.ts', 'c.ts']) {
    await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: `/home/owner/my-app/src/${file}`,
        old_string: 'x',
        new_string: GITHUB_TOKEN,
      },
    })
  }
  await hook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: {
      command: `curl -H "token ${GITHUB_TOKEN}"`,
      description: `Check ${GITHUB_TOKEN}`,
    },
  })
  await tick(4)
  expect(edits()).toHaveLength(1)
  const text = edits()[0]?.text ?? ''
  expect(edits()[0]?.message_id).toBe(id)
  expect(text).toContain('State: working since')
  expect(text).toContain(`Last tool: Bash · Check ${REDACTION_MARK}`)
  expect(JSON.stringify(api.calls)).not.toContain(GITHUB_TOKEN)
  expect(JSON.stringify(api.calls)).not.toContain('curl')

  // Nothing changes: a minute of ticks, no edit.
  await tick(60)
  expect(edits()).toHaveLength(1)

  // The turn ends: idle, with the finish time.
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'done' })
  await tick(4)
  expect(edits()).toHaveLength(2)
  expect(edits()[1]?.text).toContain('State: idle since')
  expect(edits()[1]?.text).toContain('Last finished:')
})

test('a restart keeps the message id and keeps editing it', async () => {
  await start()
  const id = await pinned()
  await stop()
  // The shutdown marked it ended.
  expect(edits().at(-1)).toMatchObject({ message_id: id })
  expect(edits().at(-1)?.text).toContain('State: session ended')

  await start()
  clock.advance(STATUS_MIN_INTERVAL_MS)
  await hook({ hook_event_name: 'UserPromptSubmit' })
  await tick(4)
  expect(edits().at(-1)).toMatchObject({ message_id: id })
  expect(edits().at(-1)?.text).toContain('State: working')
  expect(sends()).toHaveLength(1)
})

test('a deleted message is recreated and pinned once, then the bridge gives up quietly', async () => {
  await start()
  await pinned()
  const gone = {
    ok: false as const,
    error_code: 400,
    description: 'Bad Request: message to edit not found',
  }
  api.script('editMessageText', gone, gone)
  await hook({ hook_event_name: 'UserPromptSubmit' })
  await tick(4)
  expect(statusSends()).toHaveLength(2)
  expect(pins()).toHaveLength(2)
  const recreated = pins()[1]?.message_id
  expect(state.statusMessages.find(OWNER_ID)?.messageId).toBe(String(recreated))

  clock.advance(STATUS_MIN_INTERVAL_MS)
  await hook({ hook_event_name: 'Stop' })
  await tick(4)
  expect(statusSends()).toHaveLength(2)
  expect(state.statusMessages.list()).toEqual([])
  await hook({ hook_event_name: 'UserPromptSubmit' })
  await tick(10)
  expect(api.callsTo('editMessageText')).toHaveLength(2)
})

test('/unpin removes it and stops updates', async () => {
  await start()
  const id = await pinned()
  api.sendText(PHONE_OWNER, '/unpin')
  await until(() => api.callsTo('unpinChatMessage').length === 1, 'the unpin')
  expect(api.callsTo('unpinChatMessage')[0]?.payload).toMatchObject({
    chat_id: OWNER_ID,
    message_id: id,
  })
  await until(() => sends().length === 2, 'the reply')
  expect(sends()[1]?.payload.text).toBe(en.unpinDone)
  await hook({ hook_event_name: 'UserPromptSubmit' })
  await tick(10)
  expect(edits()).toEqual([])
  expect(state.statusMessages.list()).toEqual([])
})

test('a stranger cannot pin', async () => {
  await start()
  api.sendText(STRANGER, '/pin')
  await until(() => api.idle, 'the poller')
  await settle()
  expect(pins()).toEqual([])
  expect(sends()).toEqual([])
  expect(state.statusMessages.list()).toEqual([])
})

test('a flood wait on status edits does not delay /stop, and no edit retries', async () => {
  await start()
  await pinned()
  api.script('editMessageText', {
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry after 3600',
    parameters: { retry_after: 3600 },
  })
  await hook({ hook_event_name: 'UserPromptSubmit' })
  await tick(4)
  expect(api.callsTo('editMessageText')).toHaveLength(1)

  api.sendText(PHONE_OWNER, '/stop')
  await until(() => state.brake.status().engaged, 'the brake')
  await until(() => sends().length === 2, 'the /stop answer')
  // The braked render waits out the flood: still one edit attempt.
  await tick(30)
  expect(api.callsTo('editMessageText')).toHaveLength(1)
})
