/**
 * F4 acceptance: notices via hooks. The real composition (MCP server over an
 * in-memory transport, SQLite state, grammY poller, inbound chain, outbound
 * decorators, the real hook IPC listener on a named pipe or Unix socket)
 * against an in-process fake of the Bot API. Hook events arrive the way
 * Claude Code sends them: through the real hook entrypoint (one test spawns
 * `src/hook.ts`) or its client. No network, fake clock.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { hookEndpoint } from '../../src/adapters/ipc/endpoint.ts'
import { encodeFrame } from '../../src/adapters/ipc/frame.ts'
import { HookIpcServer } from '../../src/adapters/ipc/HookIpcServer.ts'
import { sendHookFrame } from '../../src/adapters/ipc/hookClient.ts'
import { loadOrCreateHookSecret } from '../../src/adapters/ipc/hookSecret.ts'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import {
  McpChannelServer,
  PERMISSION_REQUEST_METHOD,
} from '../../src/adapters/mcp/McpChannelServer.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { DotEnvProjectSecrets } from '../../src/adapters/system/DotEnvProjectSecrets.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import type { HookEventSource } from '../../src/application/ports/HookEventSource.ts'
import { createSessionTracking } from '../../src/composition/hooks.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import {
  startTelegramInbound,
  type TelegramInbound,
} from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { OWNER_QUIET_MS } from '../../src/domain/notices/NoticePolicy.ts'
import { REDACTION_MARK } from '../../src/domain/redaction/SecretRedactor.ts'
import { FakeClock, ManualEvery, MemoryLogger, SequentialRandom } from '../fakes.ts'
import { FakeTelegramApi, PHONE_OWNER, TEST_TOKEN } from '../fakeTelegram.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
const PROJECT_SECRET = 'Zq8!vR2#pL-0042-f4'
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`
const HOOK = join(import.meta.dir, '..', '..', 'src', 'hook.ts')

let stateDir: string
let projectDir: string
let state: StateStores
let inbound: TelegramInbound
let server: McpChannelServer
let client: Client
let api: FakeTelegramApi
let clock: FakeClock
let memory: MemoryLogger
let secret: Uint8Array
let listening: boolean

beforeEach(async () => {
  stateDir = makeTempDir()
  projectDir = join(makeTempDir(), 'my-app')
  mkdirSync(projectDir)
  writeFileSync(join(projectDir, '.env'), `DB_PASSWORD="${PROJECT_SECRET}"\n`)
  clock = new FakeClock()
  api = new FakeTelegramApi()
  memory = new MemoryLogger()
  listening = false
  state = openState(stateDir, {}, clock)
  state.identities.save({ id: '123456789', username: 'test_bot' })
  state.allowed.add(
    allowSender({ id: OWNER_ID, username: 'owner', displayName: 'Owner' }, clock.now()),
  )

  const logger = new RedactingLogger(memory, [TEST_TOKEN])
  const chat = buildOutbound({
    token: TEST_TOKEN,
    dev: undefined,
    literalSecrets: new DotEnvProjectSecrets([projectDir], logger).load(),
    fetch: api.fetch,
  })
  const tracking = createSessionTracking(clock)
  const sendReply = buildSendReply({
    state,
    chat,
    extraChatIds: [],
    clock,
    logger,
    onSent: () => tracking.policy.replied(clock.now()),
  })
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

  secret = loadOrCreateHookSecret(stateDir, new SequentialRandom())
  const ipc = new HookIpcServer({ endpoint: hookEndpoint(stateDir), secret, logger })
  const hooks: HookEventSource = {
    start: async (handler) => {
      const result = await ipc.start(handler)
      listening = result === 'listening'
      return result
    },
    stop: () => ipc.stop(),
  }
  inbound = startTelegramInbound({
    state,
    token: TEST_TOKEN,
    chat,
    channel: server,
    messages: en,
    clock,
    logger,
    tracking,
    hooks,
    fetch: api.fetch,
    pollTimeoutSeconds: 1,
    every: new ManualEvery().every,
    session: 'this-session',
  })
  await api.waitForPolls(1)
  await until(() => listening, 'the hook listener')
})

afterEach(async () => {
  await inbound.stop()
  await client.close()
  await server.close()
  state.db.close()
  removeTempDir(stateDir)
  removeTempDir(join(projectDir, '..'))
})

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

/** What the hook entrypoint would send, through the real client. */
async function hook(payload: Record<string, unknown>): Promise<void> {
  const frame = encodeFrame(
    secret,
    JSON.stringify({ cwd: projectDir, session_id: 's1', ...payload }),
  )
  expect(await sendHookFrame(hookEndpoint(stateDir), frame, 2_000)).toBe('acked')
}

/** Resolves once the log says the event was handled (sent or suppressed). */
async function handled(count: number): Promise<void> {
  await until(
    () =>
      memory.entries.filter(
        (e) => e.message === 'sent a notice' || e.message === 'notice suppressed',
      ).length >= count,
    'the notice decision',
  )
}

const sentTexts = () => api.callsTo('sendMessage').map((c) => c.payload.text ?? '')

test('a task started at the terminal: Stop -> exactly one redacted notice, as one message', async () => {
  const last = `Done. DB password is ${PROJECT_SECRET} and token ${GITHUB_TOKEN}.\n${'detail '.repeat(3_000)}\nAll tests pass.`
  // Through the real hook entrypoint, as Claude Code runs it.
  const child = Bun.spawn([process.execPath, HOOK, 'Stop'], {
    env: { ...process.env, TELEGRAM_BRIDGE_HOME: stateDir },
    stdin: new Blob([
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 's1',
        cwd: projectDir,
        stop_hook_active: false,
        last_assistant_message: last,
      }),
    ]),
    stdout: 'pipe',
  })
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stdout).text()).toBe('')
  await handled(1)

  const messages = api.callsTo('sendMessage')
  expect(messages).toHaveLength(1)
  const payload = messages[0]?.payload
  expect(payload?.chat_id).toBe(OWNER_ID)
  expect(payload?.parse_mode).toBeUndefined()
  expect(payload?.reply_markup).toBeUndefined()
  const text = payload?.text ?? ''
  expect(text.startsWith('✅ Claude finished in my-app.')).toBe(true)
  expect(text.length).toBeLessThanOrEqual(4096)
  expect(text).toContain(REDACTION_MARK)
  expect(text).toContain('All tests pass.')
  expect(JSON.stringify(api.calls)).not.toContain(PROJECT_SECRET)
  expect(JSON.stringify(api.calls)).not.toContain(GITHUB_TOKEN)
  expect(memory.text).not.toContain(PROJECT_SECRET)

  const rows = state.db
    .query<{ event: string; details: string }, []>('SELECT event, details FROM audit_log')
    .all()
    .filter((r) => r.event === 'notice.sent')
  expect(rows).toHaveLength(1)
  expect(JSON.parse(rows[0]?.details ?? '{}')).toMatchObject({ event: 'Stop', delivered: 1 })
  expect(rows[0]?.details).not.toContain('All tests pass')
})

test('Claude replied in the chat during the turn: Stop sends no notice', async () => {
  const result = await client.callTool({
    name: 'reply',
    arguments: { chat_id: OWNER_ID, text: 'Here is your summary.' },
  })
  expect(result.isError).toBeFalsy()
  clock.advance(30_000)
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Replied on Telegram.' })
  await handled(1)
  expect(sentTexts()).toEqual(['Here is your summary.'])
  expect(memory.text).toContain('replied_this_turn')
})

test('busy and idle from hooks drive the "queued" reply', async () => {
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'refactor everything' })
  api.sendText(PHONE_OWNER, 'also update the docs')
  await until(() => sentTexts().includes(en.queued), 'the queued note')

  clock.advance(OWNER_QUIET_MS)
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Refactored.' })
  await handled(1)
  expect(sentTexts().filter((t) => t.startsWith('✅'))).toHaveLength(1)

  api.sendText(PHONE_OWNER, 'thanks')
  await until(() => api.callsTo('sendChatAction').length === 2, 'the second typing action')
  await until(() => api.idle, 'the poller to drain')
  expect(sentTexts().filter((t) => t === en.queued)).toHaveLength(1)
})

test('PostToolUse after a terminal approval removes the buttons of the pending prompt', async () => {
  await client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run the tests',
      input_preview: '{"command":"npm test"}',
    },
  } as never)
  await until(
    () => api.callsTo('sendMessage').some((c) => c.payload.reply_markup !== undefined),
    'the prompt',
  )
  // Another Bash command that never needed a prompt leaves it alone.
  await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
  await hook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: 'ok' },
  })
  await until(() => api.callsTo('editMessageText').length === 1, 'the edit')
  const edit = api.callsTo('editMessageText')[0]?.payload
  expect(edit?.reply_markup).toEqual({ inline_keyboard: [] })
  expect(edit?.text).toContain(en.permissionResolvedLocally)
  expect(state.permissions.findById('abcde')?.state).toBe('resolved_locally')
})

test('Notification: idle_prompt asks for an answer; one F3 already relayed is not repeated', async () => {
  await hook({
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
    message: 'Claude is waiting for your input',
  })
  await handled(1)
  expect(sentTexts()).toEqual([
    '🔔 Claude needs your answer in my-app.\n\nClaude is waiting for your input',
  ])

  await client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: {
      request_id: 'fghij',
      tool_name: 'Write',
      description: 'Write a file',
      input_preview: '{}',
    },
  } as never)
  await until(() => api.callsTo('sendMessage').length === 2, 'the prompt')
  clock.advance(6_000)
  await hook({
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Write',
  })
  await handled(2)
  expect(api.callsTo('sendMessage')).toHaveLength(2)
  expect(memory.text).toContain('permission_already_relayed')
})
