/**
 * F13 acceptance: voice notes. The real composition (MCP server over an
 * in-memory transport, SQLite state, grammY poller, inbound chain, outbound
 * decorators, the whisper.cpp adapter with its scratch directory) against an
 * in-process fake of the Bot API. ffmpeg and whisper-cli are stub scripts run
 * through Bun, never real programs; no model is downloaded.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { systemProbe } from '../../src/adapters/capture/systemProbe.ts'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import {
  CHANNEL_NOTIFICATION_METHOD,
  McpChannelServer,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
} from '../../src/adapters/mcp/McpChannelServer.ts'
import { spawnCapturing } from '../../src/adapters/session/processRunner.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { UnavailableTranscriber } from '../../src/adapters/voice/createTranscriber.ts'
import { VOICE_SCRATCH_DIR } from '../../src/adapters/voice/FileAudioScratch.ts'
import { WhisperCppTranscriber } from '../../src/adapters/voice/WhisperCppTranscriber.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import type { Transcriber } from '../../src/application/ports/Transcriber.ts'
import { createSessionTracking } from '../../src/composition/hooks.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import {
  PERMISSION_SWEEP_MS,
  startTelegramInbound,
  type TelegramInbound,
} from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import {
  MAX_VOICE_BYTES,
  MAX_VOICE_SECONDS,
  VOICE_TRANSCRIPT_TTL_MS,
} from '../../src/domain/voice/voiceNote.ts'
import { fakeOgg, isAlive, type StubBehavior, VoiceStubs } from '../adapters/voice/voiceStubs.ts'
import { FakeClock, ManualEvery, MemoryLogger } from '../fakes.ts'
import { type ApiPayload, FakeTelegramApi, PHONE_OWNER, TEST_TOKEN } from '../fakeTelegram.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`
const SPOKEN = 'Please run the tests and tell me what fails'

let stateDir: string
let state: StateStores
let inbound: TelegramInbound | undefined
let server: McpChannelServer
let client: Client
let api: FakeTelegramApi
let clock: FakeClock
let timers: ManualEvery
let memory: MemoryLogger
let stubs: VoiceStubs
let notifications: { method: string; params?: unknown }[]

function whisper(behavior: StubBehavior): Transcriber {
  stubs.behave(behavior)
  return new WhisperCppTranscriber({
    whisper: stubs.whisper,
    ffmpeg: stubs.ffmpeg,
    model: stubs.model,
    language: 'en',
    env: process.env,
    run: spawnCapturing,
    probe: systemProbe,
  })
}

async function start(transcriber: Transcriber = whisper({ transcript: SPOKEN })): Promise<void> {
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
    every: timers.every,
    session: 'this-session',
    attachments: { stateDir, maxBytes: 20 * 1024 * 1024 },
    voice: { transcriber },
  })
  await api.waitForPolls(1)
}

beforeEach(() => {
  stateDir = makeTempDir()
  clock = new FakeClock(Date.UTC(2026, 10, 14, 10, 30, 5))
  api = new FakeTelegramApi()
  api.messageDate = Math.floor(clock.now() / 1000)
  timers = new ManualEvery()
  memory = new MemoryLogger()
  stubs = new VoiceStubs()
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
  stubs.remove()
  removeTempDir(stateDir)
})

async function until(probe: () => boolean, what: string, tries = 1500): Promise<void> {
  for (let i = 0; i < tries && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
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
const scratchEntries = () => {
  const root = join(stateDir, VOICE_SCRATCH_DIR)
  return existsSync(root) ? readdirSync(root) : []
}
const refusal = (reason: Parameters<typeof en.voiceRefused>[0]['reason']) =>
  en.voiceRefused({ reason, maxSeconds: MAX_VOICE_SECONDS, maxMegabytes: 2 })

/** Sends a voice note and waits for its Send/Discard prompt. */
async function transcribed(fileId = 'voice-1') {
  api.addFile(fileId, { bytes: fakeOgg(), path: `voice/${fileId}.oga` })
  api.sendVoice(PHONE_OWNER, { fileId, duration: 7, size: 2_000 })
  await until(() => state.voiceTranscripts.listPending()[0]?.prompt !== undefined, 'the prompt')
  const transcript = state.voiceTranscripts.listPending()[0]
  if (transcript === undefined) throw new Error('no transcript')
  return { id: transcript.id, messageId: Number(transcript.prompt?.messageId) }
}

test('not configured: a help reply, nothing downloaded, nothing run', async () => {
  await start(new UnavailableTranscriber('not_configured'))
  api.addFile('voice-1', { bytes: fakeOgg() })
  api.sendVoice(PHONE_OWNER, { fileId: 'voice-1', duration: 3, size: 2_000 })
  await until(() => texts().length === 1, 'the help reply')
  expect(texts()[0]).toBe(en.voiceUnavailable('not_configured'))
  expect(api.callsTo('getFile')).toEqual([])
  expect(api.downloads).toEqual([])
  expect(stubs.calls()).toEqual([])
  expect(forwarded()).toEqual([])
  expect(audit().map((r) => r.event)).toContain('voice.refused')
})

test('happy path: transcript shown, Send forwards it once as voice, audio deleted', async () => {
  await start()
  const { id, messageId } = await transcribed()

  const prompt = prompts()[0]?.payload
  expect(prompt?.text).toContain(SPOKEN)
  expect(buttons(prompt).map((b) => b.callback_data)).toEqual([`v1:${id}:s`, `v1:${id}:d`])
  expect(stubs.calls().map((c) => c.tool)).toEqual(['ffmpeg', 'whisper'])
  // Nothing reaches Claude before the owner confirms, and the audio is gone already.
  expect(forwarded()).toEqual([])
  expect(scratchEntries()).toEqual([])

  api.tap(PHONE_OWNER, messageId, `v1:${id}:s`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(answers()[0]?.text).toBe(en.voiceFeedback('sent'))
  await until(() => forwarded().length === 1, 'the delivery')
  expect(forwarded()[0]?.content).toBe(SPOKEN)
  expect(forwarded()[0]?.meta).toMatchObject({
    chat_id: OWNER_ID,
    user: 'owner',
    kind: 'voice',
    transcript_id: id,
  })
  expect(edits().at(-1)?.reply_markup).toEqual({ inline_keyboard: [] })

  api.tap(PHONE_OWNER, messageId, `v1:${id}:s`)
  await until(() => answers().length === 2, 'the second answer')
  expect(answers()[1]?.text).toBe(en.voiceFeedback('already_resolved'))
  expect(forwarded()).toHaveLength(1)

  // The audit has counts, never the words; neither does the log.
  expect(audit().map((r) => r.event)).toEqual(
    expect.arrayContaining(['voice.transcribed', 'voice.sent']),
  )
  expect(JSON.stringify(audit())).not.toContain('run the tests')
  expect(memory.text).not.toContain('run the tests')
  expect(state.voiceTranscripts.findById(id)?.text).toBe('')
})

test('Discard sends nothing to the session', async () => {
  await start()
  const { id, messageId } = await transcribed()
  api.tap(PHONE_OWNER, messageId, `v1:${id}:d`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(answers()[0]?.text).toBe(en.voiceFeedback('discarded'))
  expect(edits().at(-1)?.reply_markup).toEqual({ inline_keyboard: [] })
  expect(forwarded()).toEqual([])
  expect(state.voiceTranscripts.findById(id)?.state).toBe('discarded')
})

test('an unanswered transcript expires: buttons removed, a late Send sends nothing', async () => {
  await start()
  const { id, messageId } = await transcribed()
  clock.advance(VOICE_TRANSCRIPT_TTL_MS)
  timers.tick(PERMISSION_SWEEP_MS)
  await until(() => state.voiceTranscripts.findById(id)?.state === 'expired', 'expiry')
  await until(() => edits().length === 1, 'the expiry edit')
  expect(edits()[0]?.reply_markup).toEqual({ inline_keyboard: [] })
  api.tap(PHONE_OWNER, messageId, `v1:${id}:s`)
  await until(() => answers().length === 1, 'the late tap answer')
  expect(answers()[0]?.text).toBe(en.voiceFeedback('expired'))
  expect(forwarded()).toEqual([])
})

test('a transcript redaction would change is not offered: no prompt, no Send', async () => {
  await start(whisper({ transcript: `the token is ${GITHUB_TOKEN}` }))
  api.addFile('voice-1', { bytes: fakeOgg() })
  api.sendVoice(PHONE_OWNER, { fileId: 'voice-1', duration: 4, size: 2_000 })
  await until(() => texts().length === 1, 'the refusal')
  expect(texts()[0]).toBe(refusal('contains_secret'))
  expect(prompts()).toEqual([])
  expect(state.voiceTranscripts.listPending()).toEqual([])
  expect(JSON.stringify(audit())).not.toContain(GITHUB_TOKEN)
  expect(memory.text).not.toContain(GITHUB_TOKEN)
  expect(scratchEntries()).toEqual([])
})

test('a transcript reading /stop or /pair is sent to Claude as text, never executed', async () => {
  await start(whisper({ transcript: '/stop' }))
  const first = await transcribed('voice-1')
  api.tap(PHONE_OWNER, first.messageId, `v1:${first.id}:s`)
  await until(() => forwarded().length === 1, 'the delivery')
  expect(forwarded()[0]?.content).toBe('/stop')
  expect(state.brake.status().engaged).toBe(false)
  expect(audit().map((r) => r.event)).not.toContain('brake.engaged')

  stubs.behave({ transcript: '/pair' })
  const second = await transcribed('voice-2')
  api.tap(PHONE_OWNER, second.messageId, `v1:${second.id}:s`)
  await until(() => forwarded().length === 2, 'the second delivery')
  expect(forwarded()[1]?.content).toBe('/pair')
  expect(audit().map((r) => r.event)).not.toContain('pairing.started')
})

test('a transcript is never a permission verdict', async () => {
  await start(whisper({ transcript: 'yes abcde' }))
  await client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: { request_id: 'abcde', tool_name: 'Bash', description: 'Run', input_preview: 'ls' },
  } as never)
  await until(() => prompts().length === 1, 'the permission prompt')
  const { id, messageId } = await transcribed()
  api.tap(PHONE_OWNER, messageId, `v1:${id}:s`)
  await until(() => forwarded().length === 1, 'the delivery')
  expect(forwarded()[0]?.content).toBe('yes abcde')
  expect(notifications.filter((n) => n.method === PERMISSION_VERDICT_METHOD)).toEqual([])
  expect(state.permissions.findById('abcde')?.state).toBe('pending')
})

test('braked: a voice note gets the brake notice, a pending Send gets the brake toast', async () => {
  await start()
  const { id, messageId } = await transcribed()
  api.sendText(PHONE_OWNER, '/stop')
  await until(() => state.brake.status().engaged, 'the brake')

  api.tap(PHONE_OWNER, messageId, `v1:${id}:s`)
  await until(() => answers().length === 1, 'the tap answer')
  expect(answers()[0]?.text).toBe(en.voiceFeedback('braked'))
  expect(state.voiceTranscripts.findById(id)?.state).toBe('pending')

  const before = stubs.calls().length
  api.addFile('voice-2', { bytes: fakeOgg() })
  api.sendVoice(PHONE_OWNER, { fileId: 'voice-2', duration: 3, size: 2_000 })
  await until(() => texts().includes(en.brakeHeldMessage), 'the brake notice')
  expect(stubs.calls()).toHaveLength(before)
  expect(forwarded()).toEqual([])
})

test('too long or too big is refused before anything is downloaded', async () => {
  await start()
  api.addFile('long', { bytes: fakeOgg() })
  api.addFile('big', { bytes: fakeOgg() })
  api.sendVoice(PHONE_OWNER, { fileId: 'long', duration: MAX_VOICE_SECONDS + 1, size: 2_000 })
  api.sendVoice(PHONE_OWNER, { fileId: 'big', duration: 5, size: MAX_VOICE_BYTES + 1 })
  await until(() => texts().length === 2, 'the refusals')
  expect(texts()).toEqual([refusal('too_long'), refusal('too_large')])
  expect(api.callsTo('getFile')).toEqual([])
  expect(api.downloads).toEqual([])
  expect(stubs.calls()).toEqual([])
})

test('not Ogg: refused after the sniff, deleted, never converted', async () => {
  await start()
  api.addFile('mp3', { bytes: new TextEncoder().encode('ID3\u0003 pretending to be a voice note') })
  api.sendVoice(PHONE_OWNER, { fileId: 'mp3', duration: 3, size: 2_000 })
  await until(() => texts().length === 1, 'the refusal')
  expect(texts()[0]).toBe(refusal('not_ogg'))
  expect(stubs.calls()).toEqual([])
  expect(scratchEntries()).toEqual([])
})

test('a failed transcription deletes the audio and says so', async () => {
  await start(whisper({ whisper: 'fail' }))
  api.addFile('voice-1', { bytes: fakeOgg() })
  api.sendVoice(PHONE_OWNER, { fileId: 'voice-1', duration: 3, size: 2_000 })
  await until(() => texts().length === 1, 'the refusal')
  expect(texts()[0]).toBe(refusal('transcription_failed'))
  expect(scratchEntries()).toEqual([])
})

test('/stop is not delayed by a running transcription, and stopping kills it', async () => {
  await start(whisper({ whisper: 'hang' }))
  api.addFile('voice-1', { bytes: fakeOgg() })
  api.sendVoice(PHONE_OWNER, { fileId: 'voice-1', duration: 60, size: 2_000 })
  await until(() => stubs.hungPid() !== undefined, 'the hanging whisper-cli')
  const pid = stubs.hungPid() ?? 0

  api.sendText(PHONE_OWNER, '/stop')
  await until(() => state.brake.status().engaged, 'the brake', 500)
  await until(() => texts().length > 0, 'the /stop answer', 500)
  expect(isAlive(pid)).toBe(true)

  await inbound?.stop()
  inbound = undefined
  await until(() => !isAlive(pid), 'the kill')
  expect(scratchEntries()).toEqual([])
  expect(prompts()).toEqual([])
})
