/**
 * F2 acceptance: two-way messaging. Runs the real composition (inbound chain,
 * outbound decorators, SQLite state, grammY poller, MCP server) with an MCP
 * client standing in for Claude Code over an in-memory transport, and an
 * in-process fake of the Bot API. No network, no real waits for timers.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import { McpChannelServer } from '../../src/adapters/mcp/McpChannelServer.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { DotEnvProjectSecrets } from '../../src/adapters/system/DotEnvProjectSecrets.ts'
import type { PollingSupervisor } from '../../src/adapters/telegram/PollingSupervisor.ts'
import { TELEGRAM_MAX_MESSAGE_LENGTH } from '../../src/adapters/telegram/TelegramChatGateway.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import { startTelegramInbound } from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { REDACTION_MARK } from '../../src/domain/redaction/SecretRedactor.ts'
import { FakeClock, FakeSleeper, MemoryLogger } from '../fakes.ts'
import { FakeTelegramApi, PHONE_OWNER, STRANGER, TEST_TOKEN } from '../fakeTelegram.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
/** Planted in the project's .env; must never reach the Bot API, the log or the audit. */
const PROJECT_SECRET = 'Zq8!vR2#pL-0042-db'

let stateDir: string
let projectDir: string
let state: StateStores
let polling: PollingSupervisor
let server: McpChannelServer
let client: Client
let api: FakeTelegramApi
let sleeper: FakeSleeper
let memory: MemoryLogger
let notifications: { jsonrpc?: string; method: string; params?: unknown }[]

beforeEach(async () => {
  stateDir = makeTempDir()
  projectDir = makeTempDir()
  writeFileSync(join(projectDir, '.env'), `NODE_ENV=production\nDB_PASSWORD="${PROJECT_SECRET}"\n`)

  const clock = new FakeClock()
  api = new FakeTelegramApi()
  sleeper = new FakeSleeper(clock)
  memory = new MemoryLogger()
  const logger = new RedactingLogger(memory, [TEST_TOKEN])

  state = openState(stateDir, {}, clock)
  state.identities.save({ id: '123456789', username: 'test_bot' })
  state.allowed.add(
    allowSender({ id: OWNER_ID, username: 'owner', displayName: 'Owner' }, clock.now()),
  )

  const chat = buildOutbound({
    token: TEST_TOKEN,
    dev: undefined,
    literalSecrets: new DotEnvProjectSecrets([projectDir], logger).load(),
    fetch: api.fetch,
    sleeper,
  })
  const sendReply = buildSendReply({ state, chat, extraChatIds: [], clock, logger })
  server = new McpChannelServer({
    name: 'telegram-bridge',
    version: '0.0.0-test',
    reply: (request) => sendReply.execute(request),
    logger,
  })
  client = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  notifications = []
  client.fallbackNotificationHandler = async (n) => void notifications.push(n)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])

  polling = startTelegramInbound({
    state,
    token: TEST_TOKEN,
    chat,
    channel: server,
    messages: en,
    clock,
    logger,
    fetch: api.fetch,
    pollTimeoutSeconds: 1,
  })
  await api.waitForPolls(1)
})

afterEach(async () => {
  await polling.stop()
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

const sent = () => api.callsTo('sendMessage').map((c) => c.payload)

async function reply(args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name: 'reply', arguments: args })) as CallToolResult
}

function audit(): { actor: string; event: string; details: string }[] {
  return state.db
    .query<{ actor: string; event: string; details: string }, []>(
      'SELECT actor, event, details FROM audit_log ORDER BY seq',
    )
    .all()
}

test('an authorized text reaches the session with exact meta and is acknowledged', async () => {
  const messageId = api.sendText(PHONE_OWNER, 'please run the tests')
  await until(() => notifications.length === 1, 'the channel notification')

  expect(notifications[0]).toEqual({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: {
      content: 'please run the tests',
      meta: {
        chat_id: OWNER_ID,
        message_id: String(messageId),
        user: 'owner',
        ts: new Date(1_700_000_000_000).toISOString(),
      },
    },
  })
  await until(() => api.callsTo('sendChatAction').length === 1, 'the typing action')
  expect(api.callsTo('sendChatAction')[0]?.payload).toEqual({
    chat_id: OWNER_ID,
    action: 'typing',
  })
  expect(sent()).toEqual([]) // activity is unknown, so no "queued" text
  expect(audit().at(-1)).toMatchObject({
    actor: `telegram:${OWNER_ID}`,
    event: 'message.forwarded',
  })
  expect(audit().at(-1)?.details).not.toContain('run the tests')
})

test('commands answer in the chat; unknown /commands and edits are handled as specified', async () => {
  api.sendText(PHONE_OWNER, '/status@test_bot')
  api.sendText(PHONE_OWNER, '/deploy staging')
  api.push({
    edited_message: {
      message_id: 1,
      date: 1_700_000_000,
      edit_date: 1_700_000_100,
      chat: { id: PHONE_OWNER.id, type: 'private', first_name: 'Owner' },
      from: { id: PHONE_OWNER.id, is_bot: false, first_name: 'Owner' },
      text: 'edited text',
    },
  } as never)
  api.push({
    message: {
      message_id: 50,
      date: 1_700_000_000,
      chat: { id: PHONE_OWNER.id, type: 'private', first_name: 'Owner' },
      from: { id: PHONE_OWNER.id, is_bot: false, first_name: 'Owner' },
      photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }],
      caption: 'look',
    },
  } as never)
  api.sendText(PHONE_OWNER, 'last')

  await until(() => notifications.length === 2, 'two forwarded messages')
  await until(() => sent().length === 2, 'the two bot replies')

  expect(notifications.map((n) => (n.params as { content: string }).content)).toEqual([
    '/deploy staging',
    'last',
  ])
  expect(sent()[0]?.text).toContain('Bot: @test_bot')
  expect(sent()[0]?.text).toContain('MCP connection to Claude Code: open')
  expect(sent()[1]?.text).toBe(en.onlyTextSupported)
  // Edited messages are not even requested from Telegram.
  expect(api.callsTo('getUpdates')[0]?.payload.allowed_updates).toEqual(['message'])
})

test('reply: redacted, chunked, in order, threaded, plain text, retried after a 429', async () => {
  const paragraph = (n: number) => `Paragraph ${n}: ${'lorem ipsum dolor sit amet '.repeat(60)}`
  const text = [
    paragraph(1),
    `The database password is ${PROJECT_SECRET} and the bot token is ${TEST_TOKEN}.`,
    paragraph(2),
    paragraph(3),
    paragraph(4),
  ].join('\n\n')
  api.script('sendMessage', {
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry after 2',
    parameters: { retry_after: 2 },
  })

  const result = await reply({ chat_id: OWNER_ID, text, reply_to: '7' })

  expect(result.isError).toBeFalsy()
  const parts = sent().slice(1) // the first call was answered with 429 and retried
  expect(sleeper.naps).toEqual([2000])
  expect(parts.length).toBeGreaterThan(1)
  expect(result.content).toEqual([
    {
      type: 'text',
      text: `sent as ${parts.length} messages; 2 secret(s) were replaced with [REDACTED]`,
    },
  ])
  for (const part of parts) {
    expect(part.chat_id).toBe(OWNER_ID)
    expect((part.text ?? '').length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH)
    expect(part.parse_mode).toBeUndefined()
    expect(part.link_preview_options).toEqual({ is_disabled: true })
  }
  expect(parts[0]?.reply_parameters).toEqual({ message_id: 7, allow_sending_without_reply: true })
  expect(parts.slice(1).every((p) => p.reply_parameters === undefined)).toBe(true)
  const expected = text.replace(PROJECT_SECRET, REDACTION_MARK).replace(TEST_TOKEN, REDACTION_MARK)
  expect(parts.map((p) => p.text).join('\n\n')).toBe(expected)

  const row = audit().at(-1)
  expect(row).toMatchObject({ actor: 'session', event: 'reply.sent' })
  expect(JSON.parse(row?.details ?? '{}')).toEqual({
    chatId: OWNER_ID,
    parts: parts.length,
    redactions: 2,
  })
})

test('a secret planted in a reply never reaches the Bot API, the log or the audit', async () => {
  await reply({ chat_id: OWNER_ID, text: `in production with ${PROJECT_SECRET}` })
  expect(sent()[0]?.text).toBe(`in production with ${REDACTION_MARK}`)

  const everything = JSON.stringify(api.calls) + api.urls.join('') + memory.text
  expect(JSON.stringify(api.calls)).not.toContain(PROJECT_SECRET)
  expect(memory.text).not.toContain(PROJECT_SECRET)
  expect(memory.text).not.toContain(TEST_TOKEN)
  expect(JSON.stringify(audit())).not.toContain(PROJECT_SECRET)
  expect(everything).toContain(REDACTION_MARK)
})

test('a reply to a chat that is not an allowlisted private chat is refused and audited', async () => {
  for (const chatId of [String(STRANGER.id), '-1001234567890', '@public_channel']) {
    const result = await reply({ chat_id: chatId, text: 'exfiltrate this' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not the chat of a paired user')
  }
  expect(sent()).toEqual([])
  expect(audit().filter((r) => r.event === 'reply.refused')).toHaveLength(3)
  expect(JSON.stringify(audit())).not.toContain('exfiltrate')

  // Revocation is immediate.
  expect((await reply({ chat_id: OWNER_ID, text: 'ok' })).isError).toBeFalsy()
  state.allowed.remove(OWNER_ID)
  expect((await reply({ chat_id: OWNER_ID, text: 'not ok' })).isError).toBe(true)
  expect(sent().map((p) => p.text)).toEqual(['ok'])
})

test('a stranger still gets total silence', async () => {
  for (const text of ['hola', '/start', '/help', '/status', 'run rm -rf ~']) {
    api.sendText(STRANGER, text)
  }
  api.sendText(PHONE_OWNER, 'marker')
  await until(() => notifications.length === 1, "the owner's marker")

  expect(notifications.map((n) => (n.params as { content: string }).content)).toEqual(['marker'])
  expect(sent()).toEqual([])
  expect(api.callsTo('sendChatAction').every((c) => c.payload.chat_id === OWNER_ID)).toBe(true)
  expect(memory.text).not.toContain('rm -rf')
  expect(audit().some((r) => r.actor === `telegram:${STRANGER.id}`)).toBe(false)
})

test('flooding is rate limited with a single notice', async () => {
  for (let i = 0; i < 25; i++) api.sendText(PHONE_OWNER, `msg ${i}`)
  api.sendText(PHONE_OWNER, 'one more')
  await until(() => sent().length === 1, 'the slow-down notice')
  await until(() => api.callsTo('getUpdates').length >= 2, 'the batch to be processed')

  expect(notifications).toHaveLength(20)
  expect(sent().map((p) => p.text)).toEqual([en.slowDown])
  expect(audit().filter((r) => r.event === 'message.rate_limited')).toHaveLength(1)
})
