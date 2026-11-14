/**
 * F7 acceptance: `ask_choice` buttons and `/skills`. The real composition
 * (MCP server over an in-memory transport, SQLite state, grammY poller,
 * inbound chain, outbound decorators) against an in-process fake of the Bot
 * API. An MCP client stands in for Claude Code. Skills live in temp
 * directories, never the real home. A fake clock; timers ticked by hand.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
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
import { DiskSkillFiles } from '../../src/adapters/skills/DiskSkillFiles.ts'
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
import { CHOICE_TTL_MS, Choice } from '../../src/domain/choices/Choice.ts'
import { skillKey } from '../../src/domain/skills/skillFrontmatter.ts'
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
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`

let stateDir: string
let projectDir: string
let userSkillsDir: string
let state: StateStores
let inbound: TelegramInbound | undefined
let server: McpChannelServer
let client: Client
let api: FakeTelegramApi
let clock: FakeClock
let timers: ManualEvery
let memory: MemoryLogger
let notifications: { method: string; params?: unknown }[]

async function start(options: { projectKnown?: boolean } = {}): Promise<void> {
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
    askChoice: async (request) =>
      inbound === undefined
        ? { status: 'refused', reason: 'not_polling' }
        : inbound.choices.ask.execute(request),
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
    skillFiles: new DiskSkillFiles({
      projectDir: options.projectKnown === false ? undefined : projectDir,
      userSkillsDir,
      logger,
    }),
  })
  await api.waitForPolls(1)
}

beforeEach(() => {
  stateDir = makeTempDir()
  projectDir = makeTempDir()
  userSkillsDir = join(makeTempDir(), 'skills')
  clock = new FakeClock()
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
  removeTempDir(join(userSkillsDir, '..'))
})

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

async function quiesce(): Promise<void> {
  await until(() => api.idle, 'the poller to drain its updates')
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }

async function askChoice(args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: 'ask_choice', arguments: args })) as ToolResult
}

/** Asks and returns the choice id and the message id of its buttons. */
async function asked(
  options: readonly string[] = ['Postgres', 'SQLite'],
  extra: Record<string, unknown> = {},
): Promise<{ choiceId: string; messageId: number }> {
  const before = prompts().length
  const result = await askChoice({
    chat_id: OWNER_ID,
    question: 'Which database?',
    options,
    ...extra,
  })
  expect(result.isError).toBeUndefined()
  const choiceId = /choice_id=([a-z2-7]{10})/.exec(result.content[0]?.text ?? '')?.[1]
  if (choiceId === undefined) throw new Error('no choice id')
  await until(() => state.choices.findById(choiceId)?.prompt !== undefined, 'the prompt ref')
  return {
    choiceId,
    messageId: Number(state.choices.findById(choiceId)?.prompt?.messageId ?? before),
  }
}

const prompts = () => api.callsTo('sendMessage').filter((c) => c.payload.reply_markup !== undefined)
const texts = () => api.callsTo('sendMessage').map((c) => c.payload.text ?? '')
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

async function brake(): Promise<void> {
  api.sendText(PHONE_OWNER, '/stop')
  await until(() => state.brake.status().engaged, 'the brake')
  await quiesce()
}

test('a tap answers once: the label reaches the session and the buttons go away', async () => {
  await start()
  const { choiceId, messageId } = await asked(['Postgres', 'SQLite'], { allow_other: true })

  const prompt = prompts()[0]?.payload
  expect(prompt?.chat_id).toBe(OWNER_ID)
  expect(prompt?.text).toContain('Which database?')
  expect(buttons(prompt).map((b) => b.text)).toEqual(['Postgres', 'SQLite', 'Other…'])
  expect(buttons(prompt).map((b) => b.callback_data)).toEqual([
    `c1:${choiceId}:0`,
    `c1:${choiceId}:1`,
    `c1:${choiceId}:o`,
  ])
  // Non-blocking: nothing reached the session yet.
  expect(forwarded()).toEqual([])

  api.tap(PHONE_OWNER, messageId, `c1:${choiceId}:1`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(answers()[0]?.text).toBe(en.choiceFeedback('answered'))
  expect(forwarded()).toHaveLength(1)
  expect(forwarded()[0]?.content).toBe('SQLite')
  expect(forwarded()[0]?.meta).toMatchObject({
    chat_id: OWNER_ID,
    choice_id: choiceId,
    kind: 'choice',
    user: 'owner',
  })
  expect(edits().at(-1)?.reply_markup).toEqual({ inline_keyboard: [] })
  expect(edits().at(-1)?.text).toContain('Chosen: SQLite')
  expect(state.choices.findById(choiceId)?.state).toBe('answered')

  // A second tap (or a stale client) delivers nothing more.
  api.tap(PHONE_OWNER, messageId, `c1:${choiceId}:0`)
  await until(() => answers().length === 2, 'the second tap answer')
  expect(answers()[1]?.text).toBe(en.choiceFeedback('already_answered'))
  expect(forwarded()).toHaveLength(1)
  expect(audit().filter((r) => r.event === 'choice.answered')).toHaveLength(1)
  // The audit keeps ids and counts, never the question or the labels.
  expect(JSON.stringify(audit())).not.toContain('Which database')
  expect(JSON.stringify(audit())).not.toContain('SQLite')
})

test('a choice tap is never a permission verdict', async () => {
  await start()
  await client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: { request_id: 'abcde', tool_name: 'Bash', description: 'Run', input_preview: 'ls' },
  } as never)
  await until(() => prompts().length === 1, 'the permission prompt')
  const { choiceId, messageId } = await asked(['yes abcde', 'no abcde'])

  api.tap(PHONE_OWNER, messageId, `c1:${choiceId}:0`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(forwarded().map((e) => e.content)).toEqual(['yes abcde'])
  expect(notifications.filter((n) => n.method === PERMISSION_VERDICT_METHOD)).toEqual([])
  expect(state.permissions.findById('abcde')?.state).toBe('pending')

  // Forged or malformed data does nothing either.
  for (const data of [`c1:${choiceId}:9`, 'c1:abc:0', `c1:${choiceId}:0:a`, 'p1:abcde:x']) {
    api.tap(PHONE_OWNER, messageId, data)
  }
  await until(() => answers().length === 5, 'the forged taps answers')
  expect(forwarded()).toHaveLength(1)
  expect(notifications.filter((n) => n.method === PERMISSION_VERDICT_METHOD)).toEqual([])
})

test('a stranger tap or a tap from a group is dropped', async () => {
  await start()
  const { choiceId, messageId } = await asked()
  api.tap(STRANGER, messageId, `c1:${choiceId}:0`)
  api.tap(PHONE_OWNER, messageId, `c1:${choiceId}:0`, { id: -100123, type: 'supergroup' })
  await quiesce()
  expect(answers()).toEqual([])
  expect(forwarded()).toEqual([])
  expect(state.choices.findById(choiceId)?.state).toBe('pending')
})

test('while braked a tap is refused with a toast and nothing is forwarded', async () => {
  await start()
  const { choiceId, messageId } = await asked()
  await brake()

  api.tap(PHONE_OWNER, messageId, `c1:${choiceId}:0`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(answers()[0]?.text).toBe(en.choiceFeedback('braked'))
  expect(forwarded()).toEqual([])
  expect(state.choices.findById(choiceId)?.state).toBe('pending')

  api.sendText(PHONE_OWNER, '/resume')
  await until(() => !state.brake.status().engaged, 'the release')
  api.tap(PHONE_OWNER, messageId, `c1:${choiceId}:0`)
  await until(() => answers().length === 2, 'the second tap answer')
  expect(forwarded().map((e) => e.content)).toEqual(['Postgres'])
})

test('"Other…": the next text answers the choice and carries its id', async () => {
  await start()
  const { choiceId, messageId } = await asked(['A', 'B'], { allow_other: true })

  api.tap(PHONE_OWNER, messageId, `c1:${choiceId}:o`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(answers()[0]?.text).toBe(en.choiceFeedback('awaiting_text'))
  expect(edits().at(-1)?.text).toContain('Write your answer')
  expect(forwarded()).toEqual([])

  // A command is not an answer.
  api.sendText(PHONE_OWNER, '/status')
  await quiesce()
  expect(state.choices.findById(choiceId)?.state).toBe('awaiting_text')

  api.sendText(PHONE_OWNER, 'MariaDB, please')
  await until(() => forwarded().length === 1, 'the typed answer')
  expect(forwarded()[0]?.content).toBe('MariaDB, please')
  expect(forwarded()[0]?.meta).toMatchObject({ choice_id: choiceId, kind: 'choice' })
  expect(state.choices.findById(choiceId)?.state).toBe('answered')
  await until(() => (edits().at(-1)?.text ?? '').includes('Answered with a message'), 'the edit')

  // The text after that is an ordinary message.
  api.sendText(PHONE_OWNER, 'thanks')
  await until(() => forwarded().length === 2, 'the next message')
  expect(forwarded()[1]?.meta).not.toHaveProperty('choice_id')
  expect(forwarded()[1]?.meta).not.toHaveProperty('kind')
})

test('without allow_other there is no Other button and a forged one does nothing', async () => {
  await start()
  const { choiceId, messageId } = await asked()
  expect(buttons(prompts()[0]?.payload)).toHaveLength(2)
  api.tap(PHONE_OWNER, messageId, `c1:${choiceId}:o`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(state.choices.findById(choiceId)?.state).toBe('pending')
  expect(forwarded()).toEqual([])
})

test('an unanswered choice expires after 30 minutes', async () => {
  await start()
  const { choiceId, messageId } = await asked()
  clock.advance(CHOICE_TTL_MS)
  timers.tick(PERMISSION_SWEEP_MS)
  await until(() => state.choices.findById(choiceId)?.state === 'expired', 'the expiry')
  await until(() => (edits().at(-1)?.text ?? '').includes('Expired'), 'the edit')
  expect(edits().at(-1)?.reply_markup).toEqual({ inline_keyboard: [] })

  api.tap(PHONE_OWNER, messageId, `c1:${choiceId}:0`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(answers()[0]?.text).toBe(en.choiceFeedback('expired'))
  expect(forwarded()).toEqual([])
})

test('choices of an earlier session are cancelled when polling starts', async () => {
  const orphan = Choice.open({
    id: 'abcdefghij',
    session: 'dead-session',
    chatId: OWNER_ID,
    question: 'Old?',
    options: ['a', 'b'],
    allowOther: false,
    now: clock.now(),
  }).withPrompt({ chatId: OWNER_ID, messageId: '77' })
  state.choices.put(orphan)
  await start()
  await until(() => state.choices.findById('abcdefghij')?.state === 'cancelled', 'the cancel')
  await until(() => edits().some((e) => e.message_id === 77), 'the edit')

  api.tap(PHONE_OWNER, 77, 'c1:abcdefghij:0')
  await until(() => answers().length === 1, 'the tap answer')
  expect(forwarded()).toEqual([])
})

test('bad arguments and other chats are refused; nothing is sent', async () => {
  await start()
  const cases: Record<string, unknown>[] = [
    { chat_id: OWNER_ID, question: 'Q', options: ['only one'] },
    { chat_id: OWNER_ID, question: 'Q', options: ['a', 'A'] },
    { chat_id: OWNER_ID, question: 'Q', options: ['x'.repeat(65), 'b'] },
    { chat_id: OWNER_ID, question: 'Q', options: Array.from({ length: 9 }, (_, i) => `o${i}`) },
    { chat_id: OWNER_ID, question: '\u{200b}\u{202e}', options: ['a', 'b'] },
    { chat_id: '42', question: 'Q', options: ['a', 'b'] },
  ]
  for (const args of cases) {
    const result = await askChoice(args)
    expect(result.isError).toBe(true)
  }
  expect(api.callsTo('sendMessage')).toEqual([])
  expect(audit().some((r) => r.event === 'choice.refused')).toBe(true)
})

test('the question and the labels are sanitized and redacted', async () => {
  await start()
  const { messageId } = await asked([`key ${GITHUB_TOKEN}`, 'B\u{202e}A'])
  expect(messageId).toBeGreaterThan(0)
  const sent = JSON.stringify(prompts()[0]?.payload)
  expect(sent).not.toContain(GITHUB_TOKEN)
  expect(sent).not.toContain('\u{202e}')
})

test('a very long question is sent above the buttons', async () => {
  await start()
  const result = await askChoice({
    chat_id: OWNER_ID,
    question: 'word '.repeat(1500),
    options: ['a', 'b'],
  })
  expect(result.isError).toBeUndefined()
  await until(() => prompts().length === 1, 'the prompt')
  expect(prompts()[0]?.payload.text).toBe(en.choiceQuestionAbove)
  expect(texts().length).toBeGreaterThan(1)
})

function writeSkill(root: string, dir: string, frontmatter: string): void {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody\n`)
}

test('/skills lists project and personal skills; a tap asks Claude to use one', async () => {
  const projectSkills = join(projectDir, '.claude', 'skills')
  writeSkill(projectSkills, 'deploy', 'description: Ship it to production')
  writeSkill(projectSkills, 'hidden', 'user-invocable: false')
  writeSkill(projectSkills, 'Bad Name', 'description: no')
  writeSkill(userSkillsDir, 'notes', 'name: notes\ndescription: "Personal notes"')
  await start()

  api.sendText(PHONE_OWNER, '/skills')
  await until(() => prompts().length === 1, 'the menu')
  const menu = prompts()[0]?.payload
  expect(menu?.text).toContain('deploy - Ship it to production')
  expect(menu?.text).toContain('notes - Personal notes')
  expect(menu?.text).not.toContain('hidden')
  expect(buttons(menu).map((b) => b.text)).toEqual(['deploy', 'notes'])
  expect(buttons(menu)[0]?.callback_data).toBe(`k1:${skillKey('deploy')}`)

  api.tap(PHONE_OWNER, 1000, `k1:${skillKey('deploy')}`)
  await until(() => forwarded().length === 1, 'the skill request')
  expect(forwarded()[0]?.content).toBe('Use the skill /deploy')
  expect(forwarded()[0]?.meta).toMatchObject({ chat_id: OWNER_ID, user: 'owner' })
  await until(() => answers().length === 1, 'the toast')
  expect(answers()[0]?.text).toBe(en.skillFeedback('sent'))

  // While braked a skill tap sends nothing.
  await brake()
  api.tap(PHONE_OWNER, 1000, `k1:${skillKey('notes')}`)
  await until(() => answers().length === 2, 'the braked toast')
  expect(answers()[1]?.text).toBe(en.skillFeedback('braked'))
  expect(forwarded()).toHaveLength(1)
})

test('/skills pages above 8 and says when the project is unknown', async () => {
  for (let i = 0; i < 10; i++) writeSkill(userSkillsDir, `s${i}`, `description: skill ${i}`)
  await start({ projectKnown: false })
  api.sendText(PHONE_OWNER, '/skills')
  await until(() => prompts().length === 1, 'the menu')
  const first = prompts()[0]?.payload
  expect(first?.text).toContain('page 1 of 2')
  expect(first?.text).toContain('The project directory is not known')
  expect(buttons(first)).toHaveLength(9)
  expect(buttons(first).at(-1)?.callback_data).toBe('k1:p1')

  api.tap(PHONE_OWNER, 1000, 'k1:p1')
  await until(() => edits().length === 1, 'the next page')
  expect(edits()[0]?.text).toContain('page 2 of 2')
  expect((edits()[0]?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text)).toEqual([
    's8',
    's9',
    en.skillsPageButtons.previous,
  ])
})

test('/skills with nothing to list says why', async () => {
  await start({ projectKnown: false })
  api.sendText(PHONE_OWNER, '/skills')
  await until(() => texts().includes(en.skillsNone(false)), 'the reply')
})
