/**
 * F8 acceptance: git from the chat. The real composition (MCP server over an
 * in-memory transport, SQLite state, grammY poller, inbound chain, outbound
 * decorators, the read-only git adapter running the real git) against an
 * in-process fake of the Bot API. The repository is a temp one with its own
 * configuration; an MCP client stands in for Claude Code. No network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { GitCli } from '../../src/adapters/git/GitCli.ts'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import {
  CHANNEL_NOTIFICATION_METHOD,
  McpChannelServer,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
} from '../../src/adapters/mcp/McpChannelServer.ts'
import {
  type CapturingProcessRunner,
  spawnCapturing,
} from '../../src/adapters/session/processRunner.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { encodeGitCallback } from '../../src/application/git/gitCallbackData.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import { createSessionTracking } from '../../src/composition/hooks.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import {
  startTelegramInbound,
  type TelegramInbound,
} from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { REDACTION_MARK } from '../../src/domain/redaction/SecretRedactor.ts'
import { FakeClock, ManualEvery, MemoryLogger } from '../fakes.ts'
import {
  type ApiPayload,
  FakeTelegramApi,
  PHONE_OWNER,
  STRANGER,
  TEST_TOKEN,
} from '../fakeTelegram.ts'
import { commitAll, GIT, initTestRepo, isolatedGitEnv, writeIn } from '../gitRepo.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`
const PROJECT_SECRET = 'Zq8!vR2#pL-0042'

let root: string
let stateDir: string
let repo: string
let gitEnv: Record<string, string>
let state: StateStores
let inbound: TelegramInbound | undefined
let server: McpChannelServer
let client: Client
let api: FakeTelegramApi
let clock: FakeClock
let notifications: { method: string; params?: unknown }[]
let spawned: (readonly string[])[]

async function start(cwd = repo): Promise<void> {
  const logger = new RedactingLogger(new MemoryLogger(), [TEST_TOKEN])
  const chat = buildOutbound({
    token: TEST_TOKEN,
    dev: undefined,
    literalSecrets: [PROJECT_SECRET],
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
  // The real runner, counted: every git process the bridge starts is seen here.
  const run: CapturingProcessRunner = (argv, options) => {
    spawned.push(argv)
    return spawnCapturing(argv, options)
  }
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
    every: new ManualEvery().every,
    session: 'this-session',
    git: new GitCli({ gitPath: GIT ?? undefined, cwd, env: gitEnv, devNull, run }),
    project: 'my-app',
  })
  await api.waitForPolls(1)
}

beforeEach(() => {
  root = makeTempDir()
  stateDir = join(root, 'state')
  repo = join(root, 'my-app')
  gitEnv = isolatedGitEnv(join(root, 'home'))
  clock = new FakeClock()
  api = new FakeTelegramApi()
  notifications = []
  spawned = []
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
  removeTempDir(root)
})

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2500 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

async function quiesce(): Promise<void> {
  await until(() => api.idle, 'the poller to drain its updates')
}

const texts = () => api.callsTo('sendMessage').map((c) => c.payload.text ?? '')
const prompts = () => api.callsTo('sendMessage').filter((c) => c.payload.reply_markup !== undefined)
const answers = () => api.callsTo('answerCallbackQuery').map((c) => c.payload)
const buttons = (payload: ApiPayload | undefined) =>
  (payload?.reply_markup?.inline_keyboard ?? []).flat()
const forwarded = () =>
  notifications
    .filter((n) => n.method === CHANNEL_NOTIFICATION_METHOD)
    .map((n) => n.params as { content: string; meta: Record<string, string> })
const audit = () =>
  state.db
    .query<{ event: string; details: string }, []>(
      'SELECT event, details FROM audit_log ORDER BY seq',
    )
    .all()

/** A repository with staged, unstaged and untracked changes, secrets included. */
function changedRepo(): void {
  initTestRepo(repo, gitEnv)
  writeIn(repo, 'src/app.ts', 'export const a = 1\n')
  writeIn(repo, 'config.env', 'DB_HOST=localhost\n')
  commitAll(repo, gitEnv, 'init')
  writeIn(repo, 'src/app.ts', `export const a = 2\nexport const token = '${GITHUB_TOKEN}'\n`)
  writeIn(repo, 'config.env', `DB_HOST=localhost\nDB_PASSWORD=${PROJECT_SECRET}\n`)
  writeIn(repo, 'notes.md', 'untracked\n')
}

async function diffDocument(
  command = '/diff',
): Promise<{ caption: string; text: string; message: number }> {
  api.sendText(PHONE_OWNER, command)
  await until(() => prompts().length === 1, 'the /diff buttons')
  const call = api.callsTo('sendDocument')[0]
  const upload = api.uploads[0]
  expect(upload?.filename).toBe('changes.diff')
  return {
    caption: call?.payload.caption ?? '',
    text: new TextDecoder().decode(upload?.bytes),
    message: 1001,
  }
}

describe.skipIf(GIT === null)('F8', () => {
  test('/diff: a summary and a redacted .diff document, then the buttons', async () => {
    changedRepo()
    await start()
    const { caption, text } = await diffDocument()

    expect(api.callsTo('sendDocument')[0]?.payload.chat_id).toBe(OWNER_ID)
    expect(caption).toContain('📝 Changes in my-app (branch main)')
    expect(caption).toContain('0 staged, 2 unstaged, 1 untracked')
    expect(caption).toContain('2 files changed, +3 −1')
    expect(text).toContain(en.diffDocument.unstaged)
    expect(text).toContain('+export const a = 2')
    expect(text).toContain(`${en.diffDocument.untracked}\nnotes.md\n`)
    expect(text).toContain(REDACTION_MARK)
    // No secret anywhere at the fake API: the upload, the caption, any message.
    const everything = `${JSON.stringify(api.calls)}${text}`
    expect(everything).not.toContain(GITHUB_TOKEN)
    expect(everything).not.toContain(PROJECT_SECRET)

    const prompt = prompts()[0]?.payload
    expect(prompt?.text).toBe(en.gitActionsPrompt)
    expect(buttons(prompt).map((b) => b.callback_data?.slice(0, 5))).toEqual([
      'g1:c:',
      'g1:r:',
      'g1:p:',
    ])
    // Only the read-only invocations ran.
    expect(
      spawned.map((argv) =>
        argv.find((a) => ['rev-parse', 'config', 'status', 'diff'].includes(a)),
      ),
    ).toEqual(['rev-parse', 'config', 'status', 'diff', 'diff', 'diff', 'diff'])
    expect(audit().filter((r) => r.event === 'git.diff_sent')).toHaveLength(1)
    expect(JSON.stringify(audit())).not.toContain('app.ts')
  })

  test('/diff <path> narrows to that path', async () => {
    changedRepo()
    await start()
    const { caption, text } = await diffDocument('/diff src')
    expect(caption).toContain('Only: src')
    expect(text).toContain('src/app.ts')
    expect(text).not.toContain('config.env')
    expect(text).not.toContain('notes.md')
  })

  test('a secret inside a file larger than the cap never leaks', async () => {
    initTestRepo(repo, gitEnv)
    writeIn(repo, 'big.txt', 'start\n')
    commitAll(repo, gitEnv, 'init')
    const line = `${'x'.repeat(99)}\n`
    writeIn(repo, 'big.txt', `${line.repeat(30_000)}secret=${GITHUB_TOKEN}\n${line.repeat(30_000)}`)
    await start()
    const { text } = await diffDocument()
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(5_000_000)
    expect(text).not.toContain(GITHUB_TOKEN)
    expect(text).not.toContain('ghp_')
  }, 30_000)

  test('no changes: says so and sends no file', async () => {
    initTestRepo(repo, gitEnv)
    writeIn(repo, 'a.txt', 'a\n')
    commitAll(repo, gitEnv, 'init')
    await start()
    api.sendText(PHONE_OWNER, '/diff')
    await until(() => texts().length === 1, 'the reply')
    expect(texts()).toEqual(['✔️ No changes (branch main).'])
    expect(api.callsTo('sendDocument')).toEqual([])
    expect(prompts()).toEqual([])
  })

  test('not a repository', async () => {
    await start(root)
    api.sendText(PHONE_OWNER, '/diff')
    await until(() => texts().length === 1, 'the reply')
    expect(texts()).toEqual([en.diffProblem({ problem: 'not_a_repo' })])
    expect(api.callsTo('sendDocument')).toEqual([])
  })

  test('hostile paths are refused and no process is spawned', async () => {
    changedRepo()
    await start()
    const hostile = [
      '../outside',
      '/etc/passwd',
      '--output=/tmp/x',
      ':(glob)**',
      ':!src',
      'C:\\Windows',
    ]
    for (const path of hostile) api.sendText(PHONE_OWNER, `/diff ${path}`)
    await until(() => texts().length === hostile.length, 'the refusals')
    expect(texts().every((t) => t.startsWith('That path is not accepted'))).toBe(true)
    expect(spawned).toEqual([])
    expect(api.callsTo('sendDocument')).toEqual([])
  })

  test('/status gains a git line', async () => {
    changedRepo()
    await start()
    api.sendText(PHONE_OWNER, '/status')
    await until(() => texts().length === 1, 'the status')
    expect(texts()[0]).toContain('Git: branch main · 0 staged, 2 unstaged, 1 untracked')
  })

  test('a Commit tap is exactly one instruction to the session; Revert takes two taps', async () => {
    changedRepo()
    await start()
    const { message } = await diffDocument()
    const data = buttons(prompts()[0]?.payload).map((b) => b.callback_data ?? '')

    api.tap(PHONE_OWNER, message, data[0] ?? '')
    await until(() => forwarded().length === 1, 'the commit instruction')
    expect(forwarded()[0]?.content).toBe(en.gitInstruction('commit'))
    expect(forwarded()[0]?.meta).toMatchObject({ chat_id: OWNER_ID, user: 'owner' })
    await until(() => answers().length === 1, 'the toast')
    expect(answers()[0]?.text).toBe(en.gitTapFeedback('sent'))
    expect(api.callsTo('editMessageText').at(-1)?.payload.text).toBe(en.gitActionSent('commit'))

    // Revert: the first tap only asks.
    api.tap(PHONE_OWNER, message, data[1] ?? '')
    await until(() => answers().length === 2, 'the revert toast')
    expect(answers()[1]?.text).toBe(en.gitTapFeedback('confirm'))
    expect(forwarded()).toHaveLength(1)
    const confirm = api.callsTo('editMessageText').at(-1)?.payload
    expect(confirm?.text).toBe(en.gitRevertConfirm)
    api.tap(PHONE_OWNER, message, buttons(confirm)[0]?.callback_data ?? '')
    await until(() => forwarded().length === 2, 'the revert instruction')
    expect(forwarded()[1]?.content).toBe(en.gitInstruction('revert'))
    expect(
      audit()
        .filter((r) => r.event === 'git.action_requested')
        .map((r) => JSON.parse(r.details).action),
    ).toEqual(['commit', 'revert'])
  })

  test('a stranger tap is ignored; a braked tap is refused; a stale tap expires', async () => {
    changedRepo()
    await start()
    const { message } = await diffDocument()
    const commit = buttons(prompts()[0]?.payload)[0]?.callback_data ?? ''

    api.tap(STRANGER, message, commit)
    await quiesce()
    expect(answers()).toEqual([])
    expect(forwarded()).toEqual([])

    api.sendText(PHONE_OWNER, '/stop')
    await until(() => state.brake.status().engaged, 'the brake')
    api.tap(PHONE_OWNER, message, commit)
    await until(() => answers().length === 1, 'the braked toast')
    expect(answers()[0]?.text).toBe(en.gitTapFeedback('braked'))
    expect(forwarded()).toEqual([])

    api.sendText(PHONE_OWNER, '/resume')
    await until(() => !state.brake.status().engaged, 'the release')
    clock.advance(31 * 60_000)
    api.tap(PHONE_OWNER, message, commit)
    await until(() => answers().length === 2, 'the expired toast')
    expect(answers()[1]?.text).toBe(en.gitTapFeedback('expired'))
    expect(forwarded()).toEqual([])
  })

  test('/diff works while braked', async () => {
    changedRepo()
    await start()
    api.sendText(PHONE_OWNER, '/stop')
    await until(() => state.brake.status().engaged, 'the brake')
    await diffDocument()
    expect(api.callsTo('sendDocument')).toHaveLength(1)
  })

  test('g1 data never produces a verdict', async () => {
    changedRepo()
    await start()
    await client.notification({
      method: PERMISSION_REQUEST_METHOD,
      params: { request_id: 'abcde', tool_name: 'Bash', description: 'Run', input_preview: 'ls' },
    } as never)
    await until(() => prompts().length === 1, 'the permission prompt')
    const forged = [
      encodeGitCallback('commit', clock.now()),
      encodeGitCallback('confirm_revert', clock.now()),
      'g1:a:abcde',
      'g1:abcde:a',
      'p1:abcde:g',
    ]
    for (const data of forged) api.tap(PHONE_OWNER, 1000, data)
    await until(() => answers().length === forged.length, 'the answers')
    expect(notifications.filter((n) => n.method === PERMISSION_VERDICT_METHOD)).toEqual([])
    expect(state.permissions.findById('abcde')?.state).toBe('pending')
    // The two well-formed taps were instructions, nothing else.
    expect(forwarded().map((f) => f.content)).toEqual([
      en.gitInstruction('commit'),
      en.gitInstruction('revert'),
    ])
  })
})
