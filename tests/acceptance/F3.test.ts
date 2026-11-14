/**
 * F3 acceptance: permission relay with buttons. The real composition (MCP
 * server over an in-memory transport, SQLite state, grammY poller, inbound
 * chain, outbound decorators) against an in-process fake of the Bot API. An
 * MCP client stands in for Claude Code: it sends `permission_request` and
 * records the verdict notifications. Time is a fake clock and the expiry
 * timer is ticked by hand: no real waits for timers, no network.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import {
  McpChannelServer,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
} from '../../src/adapters/mcp/McpChannelServer.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { DotEnvProjectSecrets } from '../../src/adapters/system/DotEnvProjectSecrets.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import {
  PERMISSION_SWEEP_MS,
  startTelegramInbound,
  type TelegramInbound,
} from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import {
  PERMISSION_TTL_MS,
  PermissionRequest,
} from '../../src/domain/permissions/PermissionRequest.ts'
import { REDACTION_MARK } from '../../src/domain/redaction/SecretRedactor.ts'
import { FakeClock, ManualEvery, MemoryLogger } from '../fakes.ts'
import {
  type ApiPayload,
  FakeTelegramApi,
  PHONE_OWNER,
  STRANGER,
  TEST_TOKEN,
} from '../fakeTelegram.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
const PROJECT_SECRET = 'Zq8!vR2#pL-0042-db'
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`

let stateDir: string
let projectDir: string
let state: StateStores
let inbound: TelegramInbound
let server: McpChannelServer
let client: Client
let api: FakeTelegramApi
let clock: FakeClock
let timers: ManualEvery
let memory: MemoryLogger
let notifications: { method: string; params?: unknown }[]

async function start(): Promise<void> {
  const logger = new RedactingLogger(memory, [TEST_TOKEN])
  const chat = buildOutbound({
    token: TEST_TOKEN,
    dev: undefined,
    literalSecrets: new DotEnvProjectSecrets([projectDir], logger).load(),
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
  client.fallbackNotificationHandler = async (n) => void notifications.push(n)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
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
    every: timers.every,
    session: 'this-session',
  })
  await api.waitForPolls(1)
}

beforeEach(async () => {
  stateDir = makeTempDir()
  projectDir = makeTempDir()
  writeFileSync(join(projectDir, '.env'), `DB_PASSWORD="${PROJECT_SECRET}"\n`)
  clock = new FakeClock()
  api = new FakeTelegramApi()
  timers = new ManualEvery()
  memory = new MemoryLogger()
  notifications = []
  state = openState(stateDir, {}, clock)
  state.identities.save({ id: '123456789', username: 'test_bot' })
  state.allowed.add(
    allowSender({ id: OWNER_ID, username: 'owner', displayName: 'Owner' }, clock.now()),
  )
})

afterEach(async () => {
  await inbound.stop()
  await client.close()
  await server.close()
  state.db.close()
  removeTempDir(stateDir)
  removeTempDir(projectDir)
})

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

/** Lets every queued update be handled before asserting that nothing happened. */
async function quiesce(): Promise<void> {
  await until(() => api.idle, 'the poller to drain its updates')
}

async function ask(request_id: string, input_preview: string, tool_name = 'Bash'): Promise<void> {
  await client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: { request_id, tool_name, description: 'Run a command', input_preview },
  } as never)
}

const verdicts = () =>
  notifications.filter((n) => n.method === PERMISSION_VERDICT_METHOD).map((n) => n.params)
const prompts = () => api.callsTo('sendMessage').filter((c) => c.payload.reply_markup !== undefined)
const edits = () => api.callsTo('editMessageText').map((c) => c.payload)
const answers = () => api.callsTo('answerCallbackQuery').map((c) => c.payload)
const buttons = (payload: ApiPayload | undefined) =>
  (payload?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data)

/** The fake numbers sent messages from 1000, in order. */
function promptMessageId(index = 0): number {
  const all = api.callsTo('sendMessage')
  const prompt = prompts()[index]
  return 1000 + all.indexOf(prompt as (typeof all)[number])
}

function audit(): { actor: string; event: string; details: string }[] {
  return state.db
    .query<{ actor: string; event: string; details: string }, []>(
      'SELECT actor, event, details FROM audit_log ORDER BY seq',
    )
    .all()
}

async function relayed(id: string, preview: string): Promise<number> {
  const before = prompts().length
  await ask(id, preview)
  await until(() => prompts().length === before + 1, 'the prompt')
  await until(
    () => audit().some((r) => r.event === 'permission.relayed' && r.details.includes(id)),
    'the relay to finish',
  )
  return promptMessageId(before)
}

test('approve: one tap sends allow, removes the buttons and answers the tap', async () => {
  await start()
  const messageId = await relayed('abcde', '{"command":"ls -la"}')

  const prompt = prompts()[0]?.payload
  expect(prompt?.chat_id).toBe(OWNER_ID)
  expect(prompt?.parse_mode).toBeUndefined()
  expect(prompt?.link_preview_options).toEqual({ is_disabled: true })
  expect(prompt?.text).toContain('Tool: Bash')
  expect(prompt?.text).toContain('{"command":"ls -la"}')
  expect(prompt?.text).toContain('Request abcde')
  expect(buttons(prompt)).toEqual(['p1:abcde:a', 'p1:abcde:d'])

  api.tap(PHONE_OWNER, messageId, 'p1:abcde:a')
  await until(() => answers().length === 1, 'the tap answer')

  expect(verdicts()).toEqual([{ request_id: 'abcde', behavior: 'allow' }])
  expect(edits()).toHaveLength(1)
  expect(edits()[0]).toMatchObject({ chat_id: OWNER_ID, message_id: messageId })
  expect(edits()[0]?.reply_markup).toEqual({ inline_keyboard: [] })
  expect(edits()[0]?.text).toContain('✅ Approved by @owner')
  expect(answers()[0]).toMatchObject({ text: en.permissionFeedback('approved') })

  const events = audit().map((r) => r.event)
  expect(events).toContain('permission.relayed')
  expect(audit().at(-1)).toMatchObject({
    actor: `telegram:${OWNER_ID}`,
    event: 'permission.approved',
  })
  expect(JSON.stringify(audit())).not.toContain('ls -la')
})

test('deny: one tap sends deny', async () => {
  await start()
  const messageId = await relayed('fghij', '{"command":"ls"}')
  api.tap(PHONE_OWNER, messageId, 'p1:fghij:d')
  await until(() => answers().length === 1, 'the tap answer')
  expect(verdicts()).toEqual([{ request_id: 'fghij', behavior: 'deny' }])
  expect(edits()[0]?.text).toContain('❌ Denied by @owner')
})

test('high risk: the first tap asks for confirmation, the second sends allow', async () => {
  await start()
  const messageId = await relayed('kmnop', '{"command":"git push --force origin main"}')
  expect(prompts()[0]?.payload.text).toContain('Risk: HIGH')

  api.tap(PHONE_OWNER, messageId, 'p1:kmnop:a')
  await until(() => answers().length === 1, 'the first answer')
  expect(verdicts()).toEqual([])
  expect(buttons(edits()[0])).toEqual(['p1:kmnop:c', 'p1:kmnop:x'])
  expect(answers()[0]).toMatchObject({ text: en.permissionFeedback('confirmation_requested') })

  api.tap(PHONE_OWNER, messageId, 'p1:kmnop:c')
  await until(() => answers().length === 2, 'the second answer')
  expect(verdicts()).toEqual([{ request_id: 'kmnop', behavior: 'allow' }])
  expect(edits().at(-1)?.reply_markup).toEqual({ inline_keyboard: [] })
})

test('a double tap produces exactly one verdict', async () => {
  await start()
  const messageId = await relayed('abcde', '{"command":"ls"}')
  api.tap(PHONE_OWNER, messageId, 'p1:abcde:a')
  api.tap(PHONE_OWNER, messageId, 'p1:abcde:a')
  api.tap(PHONE_OWNER, messageId, 'p1:abcde:d')
  await until(() => answers().length === 3, 'three answers')
  expect(verdicts()).toEqual([{ request_id: 'abcde', behavior: 'allow' }])
  expect(
    answers()
      .slice(1)
      .map((a) => (a as { text?: string }).text),
  ).toEqual([en.permissionFeedback('already_resolved'), en.permissionFeedback('already_resolved')])
})

test('a tap from someone not allowlisted: no verdict, no answer, buttons stay', async () => {
  await start()
  const messageId = await relayed('abcde', '{"command":"ls"}')
  api.tap(STRANGER, messageId, 'p1:abcde:a')
  // The owner's tap from a group chat is refused as well.
  api.tap(PHONE_OWNER, messageId, 'p1:abcde:a', { id: -100123, type: 'group' })
  await quiesce()
  expect(verdicts()).toEqual([])
  expect(answers()).toEqual([])
  expect(edits()).toEqual([])
  expect(memory.text).toContain('dropped a button tap from an unauthorized sender')
})

test("a revoked sender's old button does nothing", async () => {
  await start()
  const messageId = await relayed('abcde', '{"command":"ls"}')
  state.allowed.remove(OWNER_ID)
  api.tap(PHONE_OWNER, messageId, 'p1:abcde:a')
  await quiesce()
  expect(verdicts()).toEqual([])
  expect(answers()).toEqual([])
})

test('expiry: no verdict, buttons removed, message annotated', async () => {
  await start()
  await relayed('abcde', '{"command":"ls"}')
  clock.advance(PERMISSION_TTL_MS)
  timers.tick(PERMISSION_SWEEP_MS)
  await until(() => edits().length === 1, 'the expiry edit')
  expect(edits()[0]?.reply_markup).toEqual({ inline_keyboard: [] })
  expect(edits()[0]?.text).toContain(en.permissionExpired)
  expect(verdicts()).toEqual([])
  expect(audit().at(-1)).toMatchObject({ actor: 'system', event: 'permission.expired' })

  // An old button on an expired request just says so.
  api.tap(PHONE_OWNER, promptMessageId(), 'p1:abcde:a')
  await until(() => answers().length === 1, 'the answer')
  expect(answers()[0]).toMatchObject({ text: en.permissionFeedback('expired') })
  expect(verdicts()).toEqual([])
})

test('text fallback: "yes <id>" approves and is not forwarded to Claude', async () => {
  await start()
  await relayed('abcde', '{"command":"ls"}')
  api.sendText(PHONE_OWNER, 'Yes abcde')
  await until(() => verdicts().length === 1, 'the verdict')
  expect(verdicts()).toEqual([{ request_id: 'abcde', behavior: 'allow' }])
  await until(
    () =>
      api.callsTo('sendMessage').some((c) => c.payload.text === en.permissionFeedback('approved')),
    'the acknowledgement',
  )
  expect(notifications.filter((n) => n.method === 'notifications/claude/channel')).toEqual([])
  expect(edits()[0]?.reply_markup).toEqual({ inline_keyboard: [] })
})

test('malformed callback data is ignored (answered with nothing)', async () => {
  await start()
  const messageId = await relayed('abcde', '{"command":"ls"}')
  for (const data of ['p1:abcde:allow', 'p1:zzzzz', 'x'.repeat(64), 'p2:abcde:a']) {
    api.tap(PHONE_OWNER, messageId, data)
  }
  await until(() => answers().length === 4, 'four answers')
  expect(answers().every((a) => (a as { text?: string }).text === undefined)).toBe(true)
  expect(verdicts()).toEqual([])
  expect(edits()).toEqual([])
})

test('secrets inside input_preview never reach Telegram, the log or the audit', async () => {
  await start()
  await relayed(
    'abcde',
    JSON.stringify({
      command: `psql "postgres://u:${PROJECT_SECRET}@db" && gh auth ${GITHUB_TOKEN}`,
    }),
  )
  const text = prompts()[0]?.payload.text ?? ''
  expect(text).toContain(REDACTION_MARK)
  const everything = JSON.stringify(api.calls) + memory.text + JSON.stringify(audit())
  expect(everything).not.toContain(PROJECT_SECRET)
  expect(everything).not.toContain(GITHUB_TOKEN)
})

test('/status counts pending requests; leftovers of an earlier process expire at startup', async () => {
  state.permissions.put(
    PermissionRequest.open({
      id: 'qqqqq',
      session: 'earlier-process',
      toolName: 'Write',
      description: '',
      inputPreview: '{}',
      risk: 'low',
      now: clock.now(),
    }).withPrompts([{ chatId: OWNER_ID, messageId: '42' }]),
  )
  await start()
  await until(() => edits().length === 1, 'the leftover to be expired')
  expect(edits()[0]).toMatchObject({ message_id: 42 })
  expect(state.permissions.findById('qqqqq')?.state).toBe('expired')

  await relayed('abcde', '{"command":"ls"}')
  api.sendText(PHONE_OWNER, '/status')
  await until(
    () => api.callsTo('sendMessage').some((c) => (c.payload.text ?? '').startsWith('Bot:')),
    'the status reply',
  )
  const status = api.callsTo('sendMessage').find((c) => (c.payload.text ?? '').startsWith('Bot:'))
  expect(status?.payload.text).toContain('Pending permission requests: 1')
})

test('a malformed permission_request is ignored: nothing is sent', async () => {
  await start()
  await ask('abcdl', '{"command":"ls"}')
  await ask('abcde', '{"command":"ls"}', '')
  // Notifications are handled in order: once this valid one is relayed, the others were dropped.
  await relayed('fghij', '{"command":"ls"}')
  expect(prompts()).toHaveLength(1)
  expect(prompts()[0]?.payload.text).toContain('Request fghij')
  expect(state.permissions.listOpen().map((r) => r.id)).toEqual(['fghij'])
  expect(memory.text).toContain('ignored a malformed permission request')
})
