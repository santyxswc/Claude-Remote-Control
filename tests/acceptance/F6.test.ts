/**
 * F6 acceptance: the panic button. The real composition (MCP server over an
 * in-memory transport, SQLite state, the brake flag file, grammY poller,
 * inbound chain, outbound decorators) against an in-process fake of the Bot
 * API. An MCP client stands in for Claude Code; the PreToolUse hook is the
 * real entrypoint, spawned the way Claude Code runs it. No network, a fake
 * clock, a fake session controller (never a real tmux).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import {
  McpChannelServer,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
} from '../../src/adapters/mcp/McpChannelServer.ts'
import { brakeFilePath } from '../../src/adapters/storage/brakeFile.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import { createSessionTracking } from '../../src/composition/hooks.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import {
  startTelegramInbound,
  type TelegramInbound,
} from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { FakeClock, FakeSessionController, ManualEvery, MemoryLogger } from '../fakes.ts'
import { FakeTelegramApi, PHONE_OWNER, STRANGER, TEST_TOKEN } from '../fakeTelegram.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
const BRAKE_HOOK = join(import.meta.dir, '..', '..', 'src', 'brakeHook.ts')
const CHANNEL_METHOD = 'notifications/claude/channel'

let stateDir: string
let state: StateStores
let inbound: TelegramInbound
let server: McpChannelServer
let client: Client
let api: FakeTelegramApi
let clock: FakeClock
let memory: MemoryLogger
let controller: FakeSessionController
let notifications: { method: string; params?: unknown }[]

beforeEach(async () => {
  stateDir = makeTempDir()
  clock = new FakeClock()
  api = new FakeTelegramApi()
  memory = new MemoryLogger()
  controller = new FakeSessionController('unavailable')
  notifications = []
  state = openState(stateDir, {}, clock)
  state.identities.save({ id: '123456789', username: 'test_bot' })
  state.allowed.add(
    allowSender({ id: OWNER_ID, username: 'owner', displayName: 'Owner' }, clock.now()),
  )

  const logger = new RedactingLogger(memory, [TEST_TOKEN])
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
    tracking: createSessionTracking(clock),
    hooks: undefined,
    sessionController: controller,
    every: new ManualEvery().every,
    session: 'this-session',
  })
  await api.waitForPolls(1)
})

afterEach(async () => {
  await inbound.stop()
  await client.close()
  await server.close()
  state.db.close()
  removeTempDir(stateDir)
})

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

/** The PreToolUse hook, as Claude Code runs it before a tool call. */
async function preToolUse(): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn([process.execPath, BRAKE_HOOK], {
    env: { ...process.env, TELEGRAM_BRIDGE_HOME: stateDir, TELEGRAM_BRIDGE_LOCALE: 'en' },
    stdin: new Blob([JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })]),
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return { exitCode, stdout }
}

const texts = () => api.callsTo('sendMessage').map((c) => c.payload.text ?? '')
const verdicts = () =>
  notifications.filter((n) => n.method === PERMISSION_VERDICT_METHOD).map((n) => n.params)
const forwarded = () => notifications.filter((n) => n.method === CHANNEL_METHOD)
const audit = () =>
  state.db
    .query<{ actor: string; event: string }, []>('SELECT actor, event FROM audit_log ORDER BY seq')
    .all()

async function pendingPrompt(request_id: string): Promise<void> {
  await client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: {
      request_id,
      tool_name: 'Bash',
      description: 'Run a command',
      input_preview: '{"command":"npm publish"}',
    },
  } as never)
  await until(
    () => audit().some((r) => r.event === 'permission.relayed'),
    'the prompt to be relayed',
  )
}

test('/stop brakes, denies the pending request once and says what it did; /resume undoes it', async () => {
  await pendingPrompt('abcde')
  expect((await preToolUse()).stdout).toBe('')

  api.sendText(PHONE_OWNER, '/stop wrong branch')
  await until(() => texts().some((t) => t.startsWith('🛑')), 'the /stop reply')

  // The flag is on disk, the request got exactly one deny, its prompt lost its buttons.
  expect(existsSync(brakeFilePath(stateDir))).toBe(true)
  expect(state.brake.status()).toMatchObject({ engaged: true, record: { reason: 'wrong branch' } })
  expect(verdicts()).toEqual([{ request_id: 'abcde', behavior: 'deny' }])
  const edit = api.callsTo('editMessageText')[0]?.payload
  expect(edit?.reply_markup).toEqual({ inline_keyboard: [] })
  expect(edit?.text).toContain('🛑 Denied by /stop from @owner')
  expect(controller.calls).toBe(1)
  expect(texts().at(-1)).toBe(
    en.stopReport({
      brake: 'engaged',
      since: new Date(clock.now()).toISOString(),
      denied: 1,
      interrupt: 'unavailable',
    }),
  )
  expect(texts().at(-1)).toContain('Claude will stop at its next tool call')

  // Every tool call is now refused and Claude is stopped.
  const blocked = await preToolUse()
  expect(blocked.exitCode).toBe(0)
  expect(JSON.parse(blocked.stdout)).toMatchObject({
    continue: false,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
  })
  expect(JSON.parse(blocked.stdout).stopReason).toContain('brake engaged from Telegram')

  // A message sent while braked does not reach the session.
  api.sendText(PHONE_OWNER, 'please continue')
  await until(() => texts().includes(en.brakeHeldMessage), 'the brake notice')
  expect(forwarded()).toEqual([])

  // A new permission request is denied without bothering the phone.
  const promptsBefore = api.callsTo('sendMessage').length
  await client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: { request_id: 'fghij', tool_name: 'Write', description: '', input_preview: '{}' },
  } as never)
  await until(() => verdicts().length === 2, 'the automatic deny')
  expect(verdicts()[1]).toEqual({ request_id: 'fghij', behavior: 'deny' })

  // /status says so.
  api.sendText(PHONE_OWNER, '/status')
  await until(() => texts().some((t) => t.startsWith('Bot:')), 'the status')
  expect(texts().find((t) => t.startsWith('Bot:'))).toContain('Brake: ENGAGED since')
  expect(api.callsTo('sendMessage').length).toBe(promptsBefore + 1)

  // /resume: the hook passes again and messages flow.
  api.sendText(PHONE_OWNER, '/resume')
  await until(() => texts().includes(en.resumeReleased), 'the /resume reply')
  expect(existsSync(brakeFilePath(stateDir))).toBe(false)
  expect(await preToolUse()).toEqual({ exitCode: 0, stdout: '' })
  api.sendText(PHONE_OWNER, 'now continue')
  await until(() => forwarded().length === 1, 'the forwarded message')
  expect(forwarded()[0]?.params).toMatchObject({ content: 'now continue' })

  const events = audit().map((r) => `${r.actor} ${r.event}`)
  expect(events).toContain(`telegram:${OWNER_ID} brake.engaged`)
  expect(events).toContain(`telegram:${OWNER_ID} permission.denied`)
  expect(events).toContain(`telegram:${OWNER_ID} session.stopped`)
  expect(events).toContain('system permission.denied')
  expect(events).toContain(`telegram:${OWNER_ID} brake.released`)
  expect(JSON.stringify(audit())).not.toContain('wrong branch')
})

test('a second /stop only reports that the brake is already engaged', async () => {
  api.sendText(PHONE_OWNER, '/stop')
  await until(() => texts().length === 1, 'the first reply')
  clock.advance(60_000)
  api.sendText(PHONE_OWNER, '/stop')
  await until(() => texts().length === 2, 'the second reply')
  expect(texts()[1]).toStartWith('🛑 The brake was already engaged')
  expect(controller.calls).toBe(1)
  expect(audit().filter((r) => r.event === 'brake.engaged')).toHaveLength(1)
})

test('/stop from a stranger does nothing at all', async () => {
  await pendingPrompt('abcde')
  const sentBefore = api.callsTo('sendMessage').length
  api.sendText(STRANGER, '/stop')
  api.sendText(STRANGER, '/resume')
  await until(() => api.idle, 'the poller to drain')
  expect(existsSync(brakeFilePath(stateDir))).toBe(false)
  expect(state.brake.status()).toEqual({ engaged: false })
  expect(verdicts()).toEqual([])
  expect(controller.calls).toBe(0)
  expect(api.callsTo('sendMessage')).toHaveLength(sentBefore)
  expect(api.callsTo('editMessageText')).toEqual([])
  expect(await preToolUse()).toEqual({ exitCode: 0, stdout: '' })
})
