/**
 * F12 acceptance: `/wrap`, `save_session_summary` and `propose_memory`. The
 * real composition (MCP server over an in-memory transport, SQLite state,
 * grammY poller, inbound chain, outbound decorators, the project-file
 * adapters) against an in-process fake of the Bot API. An MCP client stands
 * in for Claude Code. The project is a temp directory, never a real one.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import {
  CHANNEL_NOTIFICATION_METHOD,
  McpChannelServer,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
} from '../../src/adapters/mcp/McpChannelServer.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import { createSessionTracking } from '../../src/composition/hooks.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import {
  PERMISSION_SWEEP_MS,
  startTelegramInbound,
  type TelegramInbound,
} from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { MEMORY_PROPOSAL_TTL_MS } from '../../src/domain/memory/MemoryProposal.ts'
import { FakeClock, ManualEvery, MemoryLogger } from '../fakes.ts'
import { type ApiPayload, FakeTelegramApi, PHONE_OWNER, TEST_TOKEN } from '../fakeTelegram.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`
const LINES = ['Run bun run check before every commit', 'Charts render in a child process']

let stateDir: string
let projectDir: string
let state: StateStores
let inbound: TelegramInbound | undefined
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
    literalSecrets: [],
    fetch: api.fetch,
  })
  const sendReply = buildSendReply({ state, chat, extraChatIds: [], clock, logger })
  const wiring = () => {
    if (inbound?.memory === undefined) throw new Error('not wired')
    return inbound.memory
  }
  server = new McpChannelServer({
    name: 'telegram-bridge',
    version: '0.0.0-test',
    reply: (request) => sendReply.execute(request),
    logger,
    permissionRelay: true,
    saveSummary: (request) => wiring().saveSummary.execute(request),
    proposeMemory: (request) => wiring().propose.execute(request),
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
    every: timers.every,
    session: 'this-session',
    projectDir,
  })
  await api.waitForPolls(1)
}

beforeEach(() => {
  stateDir = makeTempDir()
  projectDir = makeTempDir()
  clock = new FakeClock(Date.UTC(2026, 10, 14, 10, 30, 5))
  api = new FakeTelegramApi()
  timers = new ManualEvery()
  memory = new MemoryLogger()
  notifications = []
  inbound = undefined
  state = openState(stateDir, {}, clock)
  state.identities.save({ id: '123456789', username: 'test_bot' })
  state.allowed.add(
    allowSender({ id: OWNER_ID, username: 'owner', displayName: 'Owner' }, clock.now()),
  )
})

afterEach(async () => {
  await inbound?.stop()
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

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }

async function tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

const texts = () => api.callsTo('sendMessage').map((c) => c.payload.text ?? '')
const prompts = () => api.callsTo('sendMessage').filter((c) => c.payload.reply_markup !== undefined)
const edits = () => api.callsTo('editMessageText').map((c) => c.payload)
const answers = () => api.callsTo('answerCallbackQuery').map((c) => c.payload)
const forwarded = () =>
  notifications
    .filter((n) => n.method === CHANNEL_NOTIFICATION_METHOD)
    .map((n) => n.params as { content: string; meta: Record<string, string> })
const buttons = (payload: ApiPayload | undefined) =>
  (payload?.reply_markup?.inline_keyboard ?? []).flat()
const audit = () =>
  state.db
    .query<{ event: string; details: string }, []>(
      'SELECT event, details FROM audit_log ORDER BY seq',
    )
    .all()
const claudeMd = () => join(projectDir, 'CLAUDE.md')

/** Proposes and returns the proposal id and the message id of its buttons. */
async function proposed(lines: readonly string[] = LINES) {
  const result = await tool('propose_memory', { chat_id: OWNER_ID, lines })
  expect(result.isError).toBeUndefined()
  const proposalId = /proposal_id=([a-z2-7]{10})/.exec(result.content[0]?.text ?? '')?.[1]
  if (proposalId === undefined) throw new Error('no proposal id')
  await until(
    () => state.memoryProposals.findById(proposalId)?.prompt !== undefined,
    'the prompt ref',
  )
  return {
    proposalId,
    messageId: Number(state.memoryProposals.findById(proposalId)?.prompt?.messageId),
  }
}

test('/wrap sends the fixed instruction through the inbound chain', async () => {
  await start()
  api.sendText(PHONE_OWNER, '/wrap')
  await until(() => forwarded().length === 1, 'the instruction')
  expect(forwarded()[0]?.content).toBe(en.wrapInstruction)
  expect(forwarded()[0]?.meta).toMatchObject({ chat_id: OWNER_ID, user: 'owner' })
  await until(() => texts().includes(en.wrapSent), 'the /wrap answer')
  expect(audit().map((r) => r.event)).toContain('wrap.requested')
})

test('/wrap while braked sends nothing to the session', async () => {
  await start()
  api.sendText(PHONE_OWNER, '/stop')
  await until(() => state.brake.status().engaged, 'the brake')
  api.sendText(PHONE_OWNER, '/wrap')
  await until(() => texts().filter((t) => t === en.brakeHeldMessage).length > 0, 'the answer')
  expect(forwarded().map((f) => f.content)).not.toContain(en.wrapInstruction)
})

test('save_session_summary: the bridge writes docs/sessions/ and sends the path and text', async () => {
  await start()
  const result = await tool('save_session_summary', {
    chat_id: OWNER_ID,
    title: 'Revisión de F12',
    markdown: `Hecho.\n\nEl token era ${GITHUB_TOKEN}.`,
  })
  expect(result.isError).toBeUndefined()
  const path = 'docs/sessions/2026-11-14T103005Z-revision-de-f12.md'
  expect(result.content[0]?.text).toContain(path)
  const written = readFileSync(join(projectDir, ...path.split('/')), 'utf8')
  expect(written.startsWith('# Revisión de F12\n\nHecho.')).toBe(true)
  // The chat copy goes through redaction; the local file is the owner's and is not redacted.
  await until(() => texts().some((t) => t.includes(path)), 'the chat notice')
  const notice = texts().find((t) => t.includes(path)) ?? ''
  expect(notice).toContain('not redacted')
  expect(notice).not.toContain(GITHUB_TOKEN)
  expect(JSON.stringify(audit())).not.toContain('Hecho')
})

test('propose_memory, then Approve: the bridge appends the lines and tells the session', async () => {
  await start()
  writeFileSync(claudeMd(), '# Project\r\n\r\nRules.\r\n')
  const { proposalId, messageId } = await proposed()

  const prompt = prompts()[0]?.payload
  for (const line of LINES) expect(prompt?.text).toContain(`- ${line}`)
  expect(buttons(prompt).map((b) => b.callback_data)).toEqual([
    `m1:${proposalId}:a`,
    `m1:${proposalId}:r`,
  ])
  // Non-blocking, and nothing written yet.
  expect(forwarded()).toEqual([])
  expect(readFileSync(claudeMd(), 'utf8')).toBe('# Project\r\n\r\nRules.\r\n')

  api.tap(PHONE_OWNER, messageId, `m1:${proposalId}:a`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(answers()[0]?.text).toBe(en.memoryFeedback('approved'))
  expect(readFileSync(claudeMd(), 'utf8')).toBe(
    `# Project\r\n\r\nRules.\r\n\r\n## Session notes\r\n\r\n- ${LINES[0]}\r\n- ${LINES[1]}\r\n`,
  )
  expect(readdirSync(projectDir)).toEqual(['CLAUDE.md'])
  expect(forwarded()).toHaveLength(1)
  expect(forwarded()[0]?.meta).toMatchObject({ kind: 'memory', proposal_id: proposalId })
  expect(forwarded()[0]?.content).toContain('approved')
  expect(edits().at(-1)?.reply_markup).toEqual({ inline_keyboard: [] })

  // One tap is enough; a second one changes nothing.
  api.tap(PHONE_OWNER, messageId, `m1:${proposalId}:a`)
  await until(() => answers().length === 2, 'the second answer')
  expect(answers()[1]?.text).toBe(en.memoryFeedback('already_resolved'))
  expect(readFileSync(claudeMd(), 'utf8').match(/- Run bun/g)).toHaveLength(1)

  const approved = audit().filter((r) => r.event === 'memory.approved')
  expect(approved).toHaveLength(1)
  expect(JSON.parse(approved[0]?.details ?? '{}')).toEqual({ proposalId, lines: 2 })
  expect(JSON.stringify(audit())).not.toContain('bun run check')
})

test('Reject writes nothing', async () => {
  await start()
  const { proposalId, messageId } = await proposed()
  api.tap(PHONE_OWNER, messageId, `m1:${proposalId}:r`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(existsSync(claudeMd())).toBe(false)
  expect(forwarded()[0]?.content).toContain('rejected')
  expect(edits().at(-1)?.reply_markup).toEqual({ inline_keyboard: [] })
})

test('a memory tap is never a permission verdict', async () => {
  await start()
  await client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: { request_id: 'abcde', tool_name: 'Bash', description: 'Run', input_preview: 'ls' },
  } as never)
  await until(() => prompts().length === 1, 'the permission prompt')
  const { proposalId, messageId } = await proposed()
  api.tap(PHONE_OWNER, messageId, `m1:${proposalId}:a`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(notifications.filter((n) => n.method === PERMISSION_VERDICT_METHOD)).toEqual([])
  expect(state.permissions.findById('abcde')?.state).toBe('pending')
})

test('braked: Approve still writes, but nothing reaches the session', async () => {
  await start()
  const { proposalId, messageId } = await proposed()
  api.sendText(PHONE_OWNER, '/stop')
  await until(() => state.brake.status().engaged, 'the brake')
  const before = forwarded().length
  api.tap(PHONE_OWNER, messageId, `m1:${proposalId}:a`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(answers()[0]?.text).toBe(en.memoryFeedback('approved_braked'))
  expect(readFileSync(claudeMd(), 'utf8')).toContain(`- ${LINES[0]}`)
  expect(forwarded()).toHaveLength(before)
})

test('a line with a secret is refused: nothing shown, nothing stored as pending', async () => {
  await start()
  const result = await tool('propose_memory', {
    chat_id: OWNER_ID,
    lines: [`The token is ${GITHUB_TOKEN}`],
  })
  expect(result.isError).toBe(true)
  expect(result.content[0]?.text).toContain('secret')
  expect(prompts()).toEqual([])
  expect(state.memoryProposals.listPending()).toEqual([])
  expect(JSON.stringify(audit())).not.toContain(GITHUB_TOKEN)
})

test('an unanswered proposal expires: buttons removed, nothing written', async () => {
  await start()
  const { proposalId, messageId } = await proposed()
  clock.advance(MEMORY_PROPOSAL_TTL_MS)
  timers.tick(PERMISSION_SWEEP_MS)
  await until(() => state.memoryProposals.findById(proposalId)?.state === 'expired', 'expiry')
  await until(() => edits().length === 1, 'the expiry edit')
  expect(edits()[0]?.reply_markup).toEqual({ inline_keyboard: [] })
  api.tap(PHONE_OWNER, messageId, `m1:${proposalId}:a`)
  await until(() => answers().length === 1, 'the late tap answer')
  expect(answers()[0]?.text).toBe(en.memoryFeedback('expired'))
  expect(existsSync(claudeMd())).toBe(false)
  expect(forwarded()).toEqual([])
})
