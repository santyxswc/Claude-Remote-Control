/**
 * F5 acceptance: screenshots on demand. The real composition (MCP server
 * over an in-memory transport, SQLite state, grammY poller, inbound chain,
 * outbound decorators, the capture factory, both capture strategies and the
 * private scratch directory) against an in-process fake of the Bot API. Only
 * the programs are fake: a fake process runner plays the browser and grim
 * and writes a real small PNG where it is told to. No network, no browser.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createScreenCapturers } from '../../src/adapters/capture/createScreenCapturers.ts'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import { McpChannelServer } from '../../src/adapters/mcp/McpChannelServer.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import { createSessionTracking } from '../../src/composition/hooks.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import { buildScreenshots } from '../../src/composition/screenshots.ts'
import {
  startTelegramInbound,
  type TelegramInbound,
} from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { fakeProbe, fakeRunner, type RunCall } from '../adapters/capture/captureFakes.ts'
import { FakeClock, FakeSessionController, ManualEvery, MemoryLogger } from '../fakes.ts'
import { FakeTelegramApi, PHONE_OWNER, STRANGER, TEST_TOKEN } from '../fakeTelegram.ts'
import { makePng } from '../png.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
const CHROMIUM = '/usr/bin/chromium'
const GRIM = '/usr/bin/grim'

let stateDir: string
let state: StateStores
let inbound: TelegramInbound
let server: McpChannelServer
let client: Client
let api: FakeTelegramApi
let clock: FakeClock
let runs: RunCall[]

beforeEach(async () => {
  stateDir = makeTempDir()
  clock = new FakeClock()
  api = new FakeTelegramApi()
  state = openState(stateDir, {}, clock)
  state.identities.save({ id: '123456789', username: 'test_bot' })
  state.allowed.add(
    allowSender({ id: OWNER_ID, username: 'owner', displayName: 'Owner' }, clock.now()),
  )

  const logger = new RedactingLogger(new MemoryLogger(), [TEST_TOKEN])
  const chat = buildOutbound({
    token: TEST_TOKEN,
    dev: undefined,
    literalSecrets: [],
    fetch: api.fetch,
  })
  const runner = fakeRunner()
  runs = runner.calls
  // An Arch box on Wayland with grim and Chromium installed.
  const setup = createScreenCapturers({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-1' },
    homeDir: '/home/owner',
    probe: fakeProbe([], { chromium: CHROMIUM, grim: GRIM }).probe,
    run: runner.run,
    logger,
  })
  const screenshots = buildScreenshots({
    stateDir,
    state,
    setup,
    images: chat,
    messages: en,
    clock,
    logger,
  })
  const sendReply = buildSendReply({ state, chat, extraChatIds: [], clock, logger })
  server = new McpChannelServer({
    name: 'telegram-bridge',
    version: '0.0.0-test',
    reply: (request) => sendReply.execute(request),
    logger,
    permissionRelay: true,
    screenshot: (request) => screenshots.execute(request),
  })
  client = new Client({ name: 'fake-claude-code', version: '0.0.0' })
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
    sessionController: new FakeSessionController('unavailable'),
    every: new ManualEvery().every,
    session: 'this-session',
    screenshots,
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

const texts = () => api.callsTo('sendMessage').map((c) => c.payload.text ?? '')
const photos = () => api.callsTo('sendPhoto')
const shotAudit = () =>
  state.db
    .query<{ actor: string; event: string; details: string }, []>(
      "SELECT actor, event, details FROM audit_log WHERE event LIKE 'screenshot.%' ORDER BY seq",
    )
    .all()

/** Every capture directory is gone (and with it the image and the browser profile). */
function scratchIsEmpty(): boolean {
  const tmp = join(stateDir, 'tmp')
  return !existsSync(tmp) || readdirSync(tmp).length === 0
}

test('/shot http://localhost:3000 sends the page as one photo with the warning caption', async () => {
  api.sendText(PHONE_OWNER, '/shot http://localhost:3000')
  await until(() => photos().length === 1, 'the photo')

  const photo = photos()[0]?.payload
  expect(photo?.chat_id).toBe(OWNER_ID)
  expect(photo?.caption).toBe(en.shotCaption({ kind: 'url', url: 'http://localhost:3000/' }))
  expect(photo?.caption).toContain('Images do not go through secret redaction')
  expect(api.uploads).toHaveLength(1)
  expect(Buffer.from(api.uploads[0]?.bytes ?? []).equals(Buffer.from(makePng(4, 3)))).toBe(true)
  expect(texts()).toEqual([])

  // The browser ran headless, with a throwaway profile in our scratch dir, the URL last after --.
  expect(runs).toHaveLength(1)
  const argv = runs[0]?.argv ?? []
  expect(argv[0]).toBe(CHROMIUM)
  expect(argv.slice(-2)).toEqual(['--', 'http://localhost:3000/'])
  const profile = argv
    .find((a) => a.startsWith('--user-data-dir='))
    ?.slice('--user-data-dir='.length)
  expect(profile?.startsWith(join(stateDir, 'tmp'))).toBe(true)
  await until(scratchIsEmpty, 'the scratch directory to be emptied')

  expect(shotAudit()).toHaveLength(1)
  const row = shotAudit()[0]
  expect(row).toMatchObject({ actor: `telegram:${OWNER_ID}`, event: 'screenshot.sent' })
  expect(JSON.parse(row?.details ?? '{}')).toMatchObject({
    kind: 'url',
    host: 'localhost:3000',
    as: 'photo',
  })
})

test('/shot alone captures the screen with the Wayland tool', async () => {
  api.sendText(PHONE_OWNER, '/shot')
  await until(() => photos().length === 1, 'the photo')
  expect(runs.map((r) => r.argv[0])).toEqual([GRIM])
  expect(photos()[0]?.payload.caption).toBe(en.shotCaption({ kind: 'screen' }))
  await until(scratchIsEmpty, 'the scratch directory to be emptied')
})

test('/shot from a stranger does nothing at all', async () => {
  api.sendText(STRANGER, '/shot http://localhost:3000')
  api.sendText(STRANGER, '/shot')
  await until(() => api.idle, 'the poller to drain')
  expect(runs).toEqual([])
  expect(api.calls.filter((c) => !['getUpdates', 'getMe'].includes(c.method))).toEqual([])
  expect(shotAudit()).toEqual([])
})

test.each([
  ['file:///etc/passwd'],
  ['javascript:alert(1)'],
  ['chrome://settings'],
  ['http://u:p@localhost'],
])('/shot %s is refused with a message and no process is spawned', async (url) => {
  api.sendText(PHONE_OWNER, `/shot ${url}`)
  await until(() => texts().length === 1, 'the refusal')
  expect(texts()[0]).toContain('only http:// or https://')
  expect(runs).toEqual([])
  expect(photos()).toEqual([])
  expect(shotAudit()[0]?.details).not.toContain(url)
})

test('send_screenshot: only to an allowlisted chat; then the photo arrives', async () => {
  const call = async (args: Record<string, unknown>) =>
    (await client.callTool({ name: 'send_screenshot', arguments: args })) as CallToolResult

  for (const chat_id of [String(STRANGER.id), '-1001234567890', 'dev']) {
    const refused = await call({ chat_id, url: 'localhost:3000' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('not the chat of a paired user')
  }
  expect(runs).toEqual([])
  expect(photos()).toEqual([])
  expect(shotAudit().every((r) => r.actor === 'session' && r.event === 'screenshot.not_sent')).toBe(
    true,
  )

  const sent = await call({ chat_id: OWNER_ID, url: 'localhost:3000' })
  expect(sent.isError).toBeUndefined()
  expect(photos()).toHaveLength(1)
  expect(scratchIsEmpty()).toBe(true)
})

test('/shot works while the brake is engaged; /status and /help know about it', async () => {
  api.sendText(PHONE_OWNER, '/stop')
  await until(() => texts().length === 1, 'the /stop reply')
  api.sendText(PHONE_OWNER, '/shot')
  await until(() => photos().length === 1, 'the photo')

  api.sendText(PHONE_OWNER, '/status')
  await until(() => texts().some((t) => t.startsWith('Bot:')), 'the status')
  expect(texts().find((t) => t.startsWith('Bot:'))).toContain('Screenshots: screen, web pages')

  api.sendText(PHONE_OWNER, '/help')
  await until(() => texts().some((t) => t.startsWith('Commands:')), 'the help')
  expect(texts().find((t) => t.startsWith('Commands:'))).toContain(
    `/shot - ${en.commandShotDescription}`,
  )
})
