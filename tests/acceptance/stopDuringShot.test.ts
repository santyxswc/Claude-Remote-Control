/**
 * M1 acceptance: `/stop` never waits behind slow work. The real composition
 * (SQLite state, grammY poller, inbound chain, outbound decorators, capture
 * strategies, scratch directory) against the fake Bot API, with a capture
 * program that only finishes when the test says so (a controlled promise,
 * no real delay).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createScreenCapturers } from '../../src/adapters/capture/createScreenCapturers.ts'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import { McpChannelServer } from '../../src/adapters/mcp/McpChannelServer.ts'
import type { ProcessRunner } from '../../src/adapters/session/processRunner.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import type { CaptureScreenshot } from '../../src/application/use-cases/CaptureScreenshot.ts'
import { createSessionTracking } from '../../src/composition/hooks.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import { buildScreenshots } from '../../src/composition/screenshots.ts'
import {
  startTelegramInbound,
  type TelegramInbound,
} from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { fakeProbe } from '../adapters/capture/captureFakes.ts'
import { FakeClock, FakeSessionController, ManualEvery, MemoryLogger } from '../fakes.ts'
import { FakeTelegramApi, PHONE_OWNER, TEST_TOKEN } from '../fakeTelegram.ts'
import { makePng } from '../png.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)

let stateDir: string
let state: StateStores
let inbound: TelegramInbound
let server: McpChannelServer
let screenshots: CaptureScreenshot
let api: FakeTelegramApi
let running: { finish: () => void; aborted: boolean }[]

/** grim that runs until `finish()` (or until killed through the abort signal). */
const gatedRunner: ProcessRunner = (argv, _timeoutMs, options) =>
  new Promise((resolve) => {
    let ended = false
    const run = {
      aborted: false,
      finish: () => {
        if (ended) return
        ended = true
        writeFileSync(argv.at(-1) ?? '', makePng(4, 3))
        resolve({ exitCode: 0, timedOut: false })
      },
    }
    options?.signal?.addEventListener('abort', () => {
      ended = true
      run.aborted = true
      resolve({ exitCode: null, timedOut: false })
    })
    running.push(run)
  })

beforeEach(async () => {
  stateDir = makeTempDir()
  running = []
  const clock = new FakeClock()
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
  screenshots = buildScreenshots({
    stateDir,
    state,
    setup: createScreenCapturers({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-1' },
      homeDir: '/home/owner',
      probe: fakeProbe([], { grim: '/usr/bin/grim' }).probe,
      run: gatedRunner,
      logger,
    }),
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
  })
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
  for (const run of running) run.finish()
  await screenshots.stop()
  await inbound.stop()
  await server.close()
  state.db.close()
  removeTempDir(stateDir)
})

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

const texts = () => api.callsTo('sendMessage').map((c) => c.payload.text ?? '')
const scratchIsEmpty = () => {
  const tmp = join(stateDir, 'tmp')
  return !existsSync(tmp) || readdirSync(tmp).length === 0
}

test('/stop engages the brake while a /shot capture is still running', async () => {
  api.sendText(PHONE_OWNER, '/shot')
  await until(() => running.length === 1, 'the capture to start')
  await until(() => texts().includes(en.shotCapturing), 'the "capturing" answer')

  api.sendText(PHONE_OWNER, '/stop')
  await until(() => state.brake.status().engaged, 'the brake')
  expect(api.callsTo('sendPhoto')).toHaveLength(0) // the capture is still pending

  running[0]?.finish()
  await until(() => api.callsTo('sendPhoto').length === 1, 'the photo')
  await until(scratchIsEmpty, 'the scratch directory to be emptied')
})

test('shutdown cancels a capture in flight: the program is killed and the scratch removed', async () => {
  api.sendText(PHONE_OWNER, '/shot')
  await until(() => running.length === 1, 'the capture to start')

  await screenshots.stop()

  expect(running[0]?.aborted).toBe(true)
  expect(scratchIsEmpty()).toBe(true)
  expect(api.callsTo('sendPhoto')).toHaveLength(0)
})
