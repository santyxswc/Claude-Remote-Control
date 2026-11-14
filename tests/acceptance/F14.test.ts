/**
 * F14 acceptance: hub mode. The real hub (grammY poller, SQLite state, the
 * outbound decorators, the HMAC-framed IPC on a temp named pipe or socket)
 * and real spokes (each a whole channel composition: MCP server, inbound
 * chain, permissions, choices, notices) in one process, against an in-process
 * fake of the Bot API. Each spoke has its own database connection to the
 * shared state directory, like separate processes. The spokes get a fetch
 * that fails the test: they never talk to Telegram. No network, temp dirs
 * only, a fake clock.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runHubInit } from '../../src/adapters/cli/hubCommands.ts'
import { SpokeLink } from '../../src/adapters/hub/SpokeLink.ts'
import { hubEndpoint } from '../../src/adapters/ipc/endpoint.ts'
import { RedactingLogger } from '../../src/adapters/logging/RedactingLogger.ts'
import {
  CHANNEL_NOTIFICATION_METHOD,
  McpChannelServer,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
} from '../../src/adapters/mcp/McpChannelServer.ts'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { CryptoRandomSource } from '../../src/adapters/system/CryptoRandomSource.ts'
import { Sha256SecretHasher } from '../../src/adapters/system/Sha256SecretHasher.ts'
import { TelegramGroupProbe } from '../../src/adapters/telegram/TelegramGroupProbe.ts'
import { TelegramPoller } from '../../src/adapters/telegram/TelegramPoller.ts'
import { GroupBindingClaimHandler } from '../../src/application/hub/GroupBindingClaimHandler.ts'
import { BindingAuditLog } from '../../src/application/hub/groupBinding.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import type { HookPayloadHandler } from '../../src/application/ports/HookEventSource.ts'
import type { PollerLock } from '../../src/application/ports/PollerLock.ts'
import type { Sleeper } from '../../src/application/ports/Sleeper.ts'
import { AuthorizeSender } from '../../src/application/use-cases/AuthorizeSender.ts'
import { AwaitPairingClaim } from '../../src/application/use-cases/AwaitPairingClaim.ts'
import { ClaimGroupBinding } from '../../src/application/use-cases/ClaimGroupBinding.ts'
import { ClaimPairing } from '../../src/application/use-cases/ClaimPairing.ts'
import { ConfirmGroupBinding } from '../../src/application/use-cases/ConfirmGroupBinding.ts'
import { StartPairing } from '../../src/application/use-cases/StartPairing.ts'
import { createSessionTracking } from '../../src/composition/hooks.ts'
import { type Hub, startHub } from '../../src/composition/hub.ts'
import { buildOutbound } from '../../src/composition/outbound.ts'
import { buildSendReply } from '../../src/composition/replies.ts'
import {
  startTelegramInbound,
  type TelegramInbound,
} from '../../src/composition/telegramInbound.ts'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { projectName } from '../../src/domain/notices/sessionNotices.ts'
import { PAIRING_TTL_MS } from '../../src/domain/Pairing.ts'
import { FakeClock, FakeLock, FakeTerminal, ManualEvery, MemoryLogger } from '../fakes.ts'
import {
  FakeTelegramApi,
  FORUM,
  type GroupChat,
  OTHER_GROUP,
  PHONE_OWNER,
  STRANGER,
  TEST_TOKEN,
} from '../fakeTelegram.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const en = messagesFor('en')
const OWNER_ID = String(PHONE_OWNER.id)
const GROUP_ID = String(FORUM.id)

let stateDir: string
let projectsRoot: string
let api: FakeTelegramApi
let clock: FakeClock
let timers: ManualEvery
let memory: MemoryLogger
let hubState: StateStores
let hub: Hub | undefined
let hookHandler: HookPayloadHandler | undefined
let spokeFetches: number
let spokes: Spoke[]

/** Spokes must never reach Telegram; any call is counted and fails. */
const forbiddenFetch = (async () => {
  spokeFetches += 1
  throw new Error('a spoke called the Telegram API')
}) as unknown as typeof fetch

interface Spoke {
  readonly session: string
  readonly state: StateStores
  readonly link: SpokeLink
  readonly inbound: TelegramInbound
  readonly server: McpChannelServer
  readonly client: Client
  readonly notifications: { method: string; params?: unknown }[]
}

beforeEach(() => {
  stateDir = makeTempDir()
  projectsRoot = makeTempDir()
  clock = new FakeClock()
  api = new FakeTelegramApi()
  timers = new ManualEvery()
  memory = new MemoryLogger()
  hub = undefined
  hookHandler = undefined
  spokeFetches = 0
  spokes = []
  hubState = openState(stateDir, {}, clock)
  hubState.identities.save({ id: '123456789', username: 'test_bot' })
  hubState.allowed.add(
    allowSender({ id: OWNER_ID, username: 'owner', displayName: 'Owner' }, clock.now()),
  )
})

afterEach(async () => {
  for (const spoke of [...spokes]) await stopSpoke(spoke)
  await hub?.stop()
  hubState.db.close()
  removeTempDir(stateDir)
  removeTempDir(projectsRoot)
  expect(spokeFetches).toBe(0)
})

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1500 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

function bindGroup(): void {
  hubState.hubGroup.save({
    chatId: GROUP_ID,
    title: FORUM.title,
    boundBy: `telegram:${OWNER_ID}`,
    boundAt: clock.now(),
  })
}

async function startTheHub(): Promise<Hub> {
  const group = hubState.hubGroup.load()
  if (group === undefined) throw new Error('bind the group first')
  const started = startHub({
    state: hubState,
    stateDir,
    token: TEST_TOKEN,
    group,
    messages: en,
    clock,
    logger: new RedactingLogger(memory, [TEST_TOKEN]),
    platform: process.platform,
    hooks: {
      start: async (handler) => {
        hookHandler = handler
        return 'listening'
      },
      stop: async () => {
        hookHandler = undefined
      },
    },
    fetch: api.fetch,
    pollTimeoutSeconds: 1,
    every: timers.every,
  })
  hub = started
  await until(() => started.isServing, 'the hub to take the lock')
  return started
}

function project(name: string): string {
  const dir = join(projectsRoot, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function startSpoke(projectDir: string, session: string): Promise<Spoke> {
  const state = openState(stateDir, {}, clock)
  const logger = new RedactingLogger(memory, [TEST_TOKEN])
  const link = new SpokeLink({
    stateDir,
    session,
    projectDir,
    projectName: projectName(projectDir),
    logger,
    initialRetryMs: 10,
    maxRetryMs: 40,
  })
  const chat = buildOutbound({
    token: TEST_TOKEN,
    dev: undefined,
    literalSecrets: [],
    fetch: forbiddenFetch,
    transport: link.transport,
  })
  const sendReply = buildSendReply({ state, chat, extraChatIds: [], clock, logger })
  let inbound: TelegramInbound | undefined
  const server = new McpChannelServer({
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
  const client = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  const notifications: { method: string; params?: unknown }[] = []
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
    fetch: forbiddenFetch,
    pollTimeoutSeconds: 1,
    tracking: createSessionTracking(clock),
    hooks: link.hooks,
    spoke: link,
    every: timers.every,
    session,
    projectDir,
  })
  const spoke = { session, state, link, inbound, server, client, notifications }
  spokes.push(spoke)
  return spoke
}

async function connected(spoke: Spoke): Promise<string> {
  await until(() => spoke.link.isPolling, `${spoke.session} to register`)
  const topic = spoke.link.topicId()
  if (topic === undefined) throw new Error('no topic')
  return topic
}

async function stopSpoke(spoke: Spoke): Promise<void> {
  const index = spokes.indexOf(spoke)
  if (index >= 0) spokes.splice(index, 1)
  await spoke.inbound.stop()
  await spoke.client.close()
  await spoke.server.close()
  spoke.state.db.close()
}

const forwarded = (spoke: Spoke) =>
  spoke.notifications
    .filter((n) => n.method === CHANNEL_NOTIFICATION_METHOD)
    .map((n) => (n.params as { content: string; meta: Record<string, string> }).content)

const verdicts = (spoke: Spoke) =>
  spoke.notifications.filter((n) => n.method === PERMISSION_VERDICT_METHOD).map((n) => n.params)

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }

async function reply(spoke: Spoke, text: string): Promise<ToolResult> {
  return (await spoke.client.callTool({
    name: 'reply',
    arguments: { chat_id: OWNER_ID, text },
  })) as ToolResult
}

async function ask(spoke: Spoke, requestId: string): Promise<number> {
  await spoke.client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: {
      request_id: requestId,
      tool_name: 'Bash',
      description: 'Run a command',
      input_preview: `echo ${requestId}`,
    },
  })
  await until(
    () => (spoke.state.permissions.findById(requestId)?.prompts.length ?? 0) > 0,
    `the prompt of ${requestId}`,
  )
  return Number(spoke.state.permissions.findById(requestId)?.prompts[0]?.messageId)
}

/** Calls of the hub to the group, as [text, thread]. */
const groupTexts = () =>
  api
    .callsTo('sendMessage')
    .filter((c) => String(c.payload.chat_id) === GROUP_ID)
    .map((c) => [c.payload.text ?? '', c.payload.message_thread_id] as const)

const inTopic = (topic: string) =>
  groupTexts()
    .filter(([, thread]) => thread === Number(topic))
    .map(([text]) => text)

const answers = () => api.callsTo('answerCallbackQuery').map((c) => c.payload.text)

describe('two sessions in one group', () => {
  test('each topic reaches only its session, replies and prompts land in their own topic', async () => {
    bindGroup()
    await startTheHub()
    const alpha = await startSpoke(project('alpha'), 'session-alpha')
    const ta = await connected(alpha)
    const beta = await startSpoke(project('beta'), 'session-beta')
    const tb = await connected(beta)
    expect(ta).not.toBe(tb)
    expect(
      api.callsTo('createForumTopic').map((c) => [String(c.payload.chat_id), c.payload.name]),
    ).toEqual([
      [GROUP_ID, 'alpha'],
      [GROUP_ID, 'beta'],
    ])
    await until(() => inTopic(tb).length === 1, 'the hello in topic beta')
    expect(inTopic(ta)).toEqual([en.hubSessionStarted('alpha')])
    expect(inTopic(tb)).toEqual([en.hubSessionStarted('beta')])

    // Inbound: by topic.
    api.sendGroupText(PHONE_OWNER, FORUM, 'hello alpha', { thread: Number(ta) })
    api.sendGroupText(PHONE_OWNER, FORUM, 'hello beta', { thread: Number(tb) })
    await until(
      () => forwarded(alpha).length === 1 && forwarded(beta).length === 1,
      'both messages',
    )
    expect(forwarded(alpha)).toEqual(['hello alpha'])
    expect(forwarded(beta)).toEqual(['hello beta'])
    // The session sees its topic as its owner's private chat.
    const meta = (
      alpha.notifications.find((n) => n.method === CHANNEL_NOTIFICATION_METHOD)?.params as {
        meta: Record<string, string>
      }
    ).meta
    expect(meta['chat_id']).toBe(OWNER_ID)

    // Outbound: the hub stamps the topic; a session cannot name another one.
    expect((await reply(alpha, 'from alpha')).isError).toBeFalsy()
    expect((await reply(beta, 'from beta')).isError).toBeFalsy()
    expect(groupTexts().filter(([text]) => text.startsWith('from '))).toEqual([
      ['from alpha', Number(ta)],
      ['from beta', Number(tb)],
    ])

    // Permission prompts: each in its topic.
    const promptA = await ask(alpha, 'abcde')
    const promptB = await ask(beta, 'fghij')
    const prompts = api
      .callsTo('sendMessage')
      .filter((c) => c.payload.reply_markup !== undefined)
      .map((c) => c.payload.message_thread_id)
    expect(prompts).toEqual([Number(ta), Number(tb)])

    // A tap in topic beta on alpha's prompt: refused by the hub, nobody hears of it.
    api.tapInTopic(PHONE_OWNER, FORUM, Number(tb), promptA, 'p1:abcde:a')
    await until(() => answers().includes(en.hubTapRefused), 'the refusal')
    // A tap on beta's own prompt carrying alpha's request: beta refuses an item it does not own.
    api.tapInTopic(PHONE_OWNER, FORUM, Number(tb), promptB, 'p1:abcde:a')
    await until(() => answers().length === 2, 'the second answer')
    expect(verdicts(alpha)).toEqual([])
    expect(verdicts(beta)).toEqual([])

    // The right tap, in the right topic.
    api.tapInTopic(PHONE_OWNER, FORUM, Number(ta), promptA, 'p1:abcde:a')
    await until(() => verdicts(alpha).length === 1, "alpha's verdict")
    expect(verdicts(alpha)).toEqual([{ request_id: 'abcde', behavior: 'allow' }])
    expect(verdicts(beta)).toEqual([])
    // The prompt was edited in place (no thread needed for an edit).
    await until(() => api.callsTo('editMessageText').length > 0, 'the edit')
    const edits = api.callsTo('editMessageText')
    expect(edits.map((c) => [String(c.payload.chat_id), c.payload.message_id])).toContainEqual([
      GROUP_ID,
      promptA,
    ])

    // Zero leakage: every message the hub sent to the group went to a session topic.
    for (const [, thread] of groupTexts()) expect([Number(ta), Number(tb)]).toContain(thread ?? -1)
    expect(forwarded(alpha)).toEqual(['hello alpha'])
    expect(forwarded(beta)).toEqual(['hello beta'])
  })

  test('the same project twice gets a second, suffixed topic', async () => {
    bindGroup()
    await startTheHub()
    const dir = project('alpha')
    const first = await startSpoke(dir, 'session-1')
    const t1 = await connected(first)
    const second = await startSpoke(dir, 'session-2')
    const t2 = await connected(second)
    expect(t1).not.toBe(t2)
    expect(api.callsTo('createForumTopic').map((c) => c.payload.name)).toEqual([
      'alpha',
      'alpha (2)',
    ])
    api.sendGroupText(PHONE_OWNER, FORUM, 'to two', { thread: Number(t2) })
    await until(() => forwarded(second).length === 1, 'the message')
    expect(forwarded(first)).toEqual([])
  })

  test('hook events go to the session whose project they come from', async () => {
    bindGroup()
    await startTheHub()
    const alphaDir = project('alpha')
    const alpha = await startSpoke(alphaDir, 'session-alpha')
    const ta = await connected(alpha)
    const beta = await startSpoke(project('beta'), 'session-beta')
    const tb = await connected(beta)
    await until(() => hookHandler !== undefined, 'the hook listener')
    await hookHandler?.({
      hook_event_name: 'Stop',
      session_id: 'claude-a',
      cwd: join(alphaDir, 'src'),
      stop_hook_active: false,
      last_assistant_message: 'All tests pass.',
    })
    // From nowhere known: dropped, never guessed.
    await hookHandler?.({
      hook_event_name: 'Stop',
      session_id: 'claude-x',
      cwd: projectsRoot,
      stop_hook_active: false,
      last_assistant_message: 'Elsewhere.',
    })
    await until(() => inTopic(ta).some((t) => t.startsWith('✅')), 'the notice in alpha')
    expect(inTopic(tb).some((t) => t.startsWith('✅'))).toBe(false)
    expect(JSON.stringify(api.calls)).not.toContain('Elsewhere.')
  })
})

describe('authentication in the group', () => {
  test('strangers, anonymous admins and other groups reach nobody and get nothing', async () => {
    bindGroup()
    await startTheHub()
    const alpha = await startSpoke(project('alpha'), 'session-alpha')
    const ta = Number(await connected(alpha))
    await until(() => inTopic(String(ta)).length === 1, 'the hello')
    const promptA = await ask(alpha, 'abcde')
    const sentBefore = api.callsTo('sendMessage').length

    api.sendGroupText(STRANGER, FORUM, 'stranger in a topic', { thread: ta })
    api.sendGroupText(STRANGER, FORUM, '/stop', { thread: ta })
    api.sendGroupText(PHONE_OWNER, FORUM, 'anonymous admin', { thread: ta, senderChat: true })
    api.sendGroupText(PHONE_OWNER, FORUM, '/stop', { thread: ta, senderChat: true })
    api.sendGroupText(PHONE_OWNER, OTHER_GROUP, 'wrong group', { thread: ta })
    api.sendGroupText(PHONE_OWNER, OTHER_GROUP, '/stop', { thread: ta })
    api.tapInTopic(STRANGER, FORUM, ta, promptA, 'p1:abcde:a')
    api.tapInTopic(PHONE_OWNER, OTHER_GROUP, ta, promptA, 'p1:abcde:a')
    // Then the owner, in the topic: once it arrives, everything before was handled.
    api.sendGroupText(PHONE_OWNER, FORUM, 'the owner', { thread: ta })
    await until(() => forwarded(alpha).length === 1, "the owner's message")

    expect(forwarded(alpha)).toEqual(['the owner'])
    expect(verdicts(alpha)).toEqual([])
    expect(hubState.brake.status().engaged).toBe(false)
    expect(api.callsTo('sendMessage').length).toBe(sentBefore)
    expect(api.callsTo('answerCallbackQuery')).toEqual([])
    expect(api.sentTo(OTHER_GROUP.id)).toEqual([])
    for (const secret of ['stranger in a topic', 'anonymous admin', 'wrong group', TEST_TOKEN]) {
      expect(memory.text).not.toContain(secret)
    }
    expect(memory.text).toContain('on_behalf_of_a_chat')
    expect(memory.text).toContain('not_the_hub_group')
  })

  test('the General topic and a topic without a session get a pointer, never a session', async () => {
    bindGroup()
    await startTheHub()
    const alpha = await startSpoke(project('alpha'), 'session-alpha')
    await connected(alpha)
    api.sendGroupText(PHONE_OWNER, FORUM, 'in general')
    api.sendGroupText(PHONE_OWNER, FORUM, 'in a stray topic', { thread: 9999 })
    await until(() => groupTexts().length === 3, 'the pointers')
    expect(groupTexts()).toContainEqual([en.hubUseATopic, undefined])
    expect(groupTexts()).toContainEqual([en.hubNoSessionHere, 9999])
    expect(forwarded(alpha)).toEqual([])
  })

  test('in the private chat only the control commands work', async () => {
    bindGroup()
    await startTheHub()
    const alpha = await startSpoke(project('alpha'), 'session-alpha')
    await connected(alpha)
    api.sendText(PHONE_OWNER, 'hello in private')
    await until(
      () => api.sentTo(OWNER_ID).some((c) => c.payload.text === en.hubPrivateChatPointer),
      'the pointer',
    )
    api.sendText(PHONE_OWNER, '/sessions')
    await until(
      () => api.sentTo(OWNER_ID).some((c) => (c.payload.text ?? '').includes('alpha')),
      'the session list',
    )
    api.sendText(STRANGER, '/stop')
    api.sendText(PHONE_OWNER, 'after the stranger')
    await until(() => api.sentTo(OWNER_ID).length === 2, 'the second pointer (throttled away)')
    await until(() => api.idle, 'the poller to drain')
    expect(hubState.brake.status().engaged).toBe(false)
    expect(api.sentTo(STRANGER.id)).toEqual([])
    expect(forwarded(alpha)).toEqual([])
  })
})

describe('the brake', () => {
  test('/stop in any topic engages the brake at once and every session denies its own prompts', async () => {
    bindGroup()
    await startTheHub()
    const alpha = await startSpoke(project('alpha'), 'session-alpha')
    const ta = await connected(alpha)
    const beta = await startSpoke(project('beta'), 'session-beta')
    const tb = await connected(beta)
    await ask(alpha, 'abcde')
    await ask(beta, 'fghij')

    const started = performance.now()
    api.sendGroupText(PHONE_OWNER, FORUM, '/stop', { thread: Number(tb) })
    await until(() => hubState.brake.status().engaged, 'the brake')
    expect(performance.now() - started).toBeLessThan(1_000)

    await until(() => verdicts(alpha).length === 1 && verdicts(beta).length === 1, 'the denials')
    expect(verdicts(alpha)).toEqual([{ request_id: 'abcde', behavior: 'deny' }])
    expect(verdicts(beta)).toEqual([{ request_id: 'fghij', behavior: 'deny' }])
    await until(() => inTopic(tb).includes(en.hubStopped('engaged', 2)), 'the hub reply')
    // Each session reports in its own topic only.
    await until(
      () => inTopic(ta).length >= 2 && inTopic(tb).length >= 3,
      'the reports of the sessions',
    )

    api.sendGroupText(PHONE_OWNER, FORUM, '/resume')
    await until(() => !hubState.brake.status().engaged, 'the release')
    await until(() => groupTexts().some(([text]) => text === en.resumeReleased), 'the reply')
  })
})

describe('robustness', () => {
  test('the hub restarts: sessions reconnect to their own topics, no new topics', async () => {
    bindGroup()
    let running = await startTheHub()
    const alpha = await startSpoke(project('alpha'), 'session-alpha')
    const ta = await connected(alpha)
    const beta = await startSpoke(project('beta'), 'session-beta')
    const tb = await connected(beta)

    await running.stop()
    hub = undefined
    await until(() => !alpha.link.isPolling && !beta.link.isPolling, 'the disconnects')
    // While the hub is away a reply fails with a clear error, and nothing is sent.
    const sentBefore = api.callsTo('sendMessage').length
    const failed = await reply(alpha, 'nobody hears this')
    expect(failed.isError).toBe(true)
    expect(failed.content[0]?.text).toContain('hub run')
    expect(api.callsTo('sendMessage').length).toBe(sentBefore)

    running = await startTheHub()
    expect(await connected(alpha)).toBe(ta)
    expect(await connected(beta)).toBe(tb)
    expect(api.callsTo('createForumTopic')).toHaveLength(2)
    // A reconnection is not announced again.
    expect(inTopic(ta).filter((t) => t === en.hubSessionStarted('alpha'))).toHaveLength(1)
    api.sendGroupText(PHONE_OWNER, FORUM, 'after the restart', { thread: Number(tb) })
    await until(() => forwarded(beta).length === 1, 'the message')
    expect(forwarded(alpha)).toEqual([])
  })

  test('a session that dies ends its topic only; the next session of the project gets it back', async () => {
    bindGroup()
    await startTheHub()
    const alphaDir = project('alpha')
    const alpha = await startSpoke(alphaDir, 'session-alpha')
    const ta = await connected(alpha)
    const beta = await startSpoke(project('beta'), 'session-beta')
    const tb = await connected(beta)

    await alpha.link.stop() // The connection drops without a word, as in a crash.
    await until(() => inTopic(ta).includes(en.hubSessionEnded), 'the end notice')
    expect(inTopic(tb)).not.toContain(en.hubSessionEnded)
    api.sendGroupText(PHONE_OWNER, FORUM, 'anyone?', { thread: Number(ta) })
    await until(() => inTopic(ta).includes(en.hubNoSessionHere), 'the pointer')
    api.sendGroupText(PHONE_OWNER, FORUM, 'beta still works', { thread: Number(tb) })
    await until(() => forwarded(beta).length === 1, 'beta')

    const again = await startSpoke(alphaDir, 'session-alpha-2')
    expect(await connected(again)).toBe(ta)
    expect(api.callsTo('createForumTopic')).toHaveLength(2)
    api.sendGroupText(PHONE_OWNER, FORUM, 'welcome back', { thread: Number(ta) })
    await until(() => forwarded(again).length === 1, 'the new session')
    expect(forwarded(alpha)).toEqual([])
  })

  test('a deleted topic is recreated once and the session moves there', async () => {
    bindGroup()
    await startTheHub()
    const alpha = await startSpoke(project('alpha'), 'session-alpha')
    const ta = await connected(alpha)
    await until(() => inTopic(ta).length === 1, 'the hello')
    api.deletedTopics.add(Number(ta))
    expect((await reply(alpha, 'still here')).isError).toBeFalsy()
    const created = api.callsTo('createForumTopic')
    expect(created).toHaveLength(2)
    const fresh = hubState.hubTopics.listAll(GROUP_ID).map((t) => t.topicId)
    expect(fresh).not.toContain(ta)
    expect(groupTexts().at(-1)?.[0]).toBe('still here')
  })
})

describe('hub mode off', () => {
  test('a channel without a bound group polls by itself and opens no hub endpoint', async () => {
    const state = openState(stateDir, {}, clock)
    const logger = new RedactingLogger(memory, [TEST_TOKEN])
    const chat = buildOutbound({
      token: TEST_TOKEN,
      dev: undefined,
      literalSecrets: [],
      fetch: api.fetch,
    })
    const server = new McpChannelServer({
      name: 'telegram-bridge',
      version: '0.0.0-test',
      reply: async () => ({ status: 'refused', reason: 'chat_not_allowed' }) as never,
      logger,
    })
    const client = new Client({ name: 'fake-claude-code', version: '0.0.0' })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverSide), client.connect(clientSide)])
    const inbound = startTelegramInbound({
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
      session: 'solo',
    })
    try {
      expect(hubState.hubGroup.load()).toBeUndefined()
      await api.waitForPolls(1)
      expect(await canConnect(hubEndpoint(stateDir).path)).toBe(false)
      expect(api.callsTo('createForumTopic')).toEqual([])
    } finally {
      await inbound.stop()
      await client.close()
      await server.close()
      state.db.close()
    }
  })
})

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

describe('hub init: binding the group', () => {
  /** A real sleeper, short; or one that moves the fake clock (to play the expiry). */
  const realSleep: Sleeper = { sleep: (ms) => Bun.sleep(Math.min(ms, 5)) }

  function initDeps(terminal: FakeTerminal, sleeper: Sleeper = realSleep, lock?: PollerLock) {
    const hasher = new Sha256SecretHasher()
    const logger = new RedactingLogger(memory, [TEST_TOKEN])
    const lifecycle = {
      pairings: hubState.groupBindings,
      audit: new BindingAuditLog(hubState.audit),
    }
    const claim = new ClaimGroupBinding({
      bindings: hubState.groupBindings,
      claim: new ClaimPairing({ ...lifecycle, hasher, clock }),
    })
    const handler = new GroupBindingClaimHandler({
      claim,
      authorize: new AuthorizeSender(hubState.allowed),
      chat: buildOutbound({
        token: TEST_TOKEN,
        dev: undefined,
        literalSecrets: [],
        fetch: api.fetch,
      }),
      messages: en,
      logger,
      botUsername: 'test_bot',
    })
    return {
      terminal,
      messages: en,
      clock,
      every: timers.every,
      heartbeatMs: 10_000,
      session: {
        botUsername: 'test_bot',
        hasOwner: hubState.allowed.list().length > 0,
        startBinding: new StartPairing({
          ...lifecycle,
          random: new CryptoRandomSource(),
          hasher,
          clock,
          links: { linkFor: (code: string) => `/bind@test_bot ${code}` },
        }),
        awaitClaim: new AwaitPairingClaim({ ...lifecycle, clock, sleeper }),
        confirmBinding: new ConfirmGroupBinding({
          bindings: hubState.groupBindings,
          hubGroup: hubState.hubGroup,
          audit: hubState.audit,
          clock,
        }),
        bindings: hubState.groupBindings,
        lock: lock ?? hubState.lock,
        createPoller: () =>
          new TelegramPoller({
            token: TEST_TOKEN,
            logger,
            fetch: api.fetch,
            pollTimeoutSeconds: 1,
          }),
        handler: (message: Parameters<GroupBindingClaimHandler['handle']>[0]) =>
          handler.handle(message),
        rights: () => new TelegramGroupProbe(TEST_TOKEN, '123456789', api.fetch),
      },
    }
  }

  async function printedCode(terminal: FakeTerminal): Promise<string> {
    await until(() => terminal.out.some((line) => line.startsWith('/bind@test_bot ')), 'the code')
    return (
      (terminal.out.find((line) => line.startsWith('/bind@test_bot ')) ?? '').split(' ')[1] ?? ''
    )
  }

  const bind = (from: typeof PHONE_OWNER, group: GroupChat, text: string) =>
    api.sendGroupText(from, group, text)

  const auditEvents = () =>
    hubState.db
      .query<{ event: string }, []>('SELECT event FROM audit_log ORDER BY seq')
      .all()
      .map((row) => row.event)

  test('only the owner, in a forum, with the right code, confirmed at the terminal', async () => {
    const terminal = new FakeTerminal()
    terminal.confirmations = [true]
    const running = runHubInit(initDeps(terminal))
    const code = await printedCode(terminal)

    bind(STRANGER, FORUM, `/bind@test_bot ${code}`)
    bind(PHONE_OWNER, FORUM, '/bind@test_bot AAAAAAAAAAAAAAAAAAAAAA')
    bind(PHONE_OWNER, { ...OTHER_GROUP, forum: false }, `/bind@test_bot ${code}`)
    bind(PHONE_OWNER, FORUM, `/bind@other_bot ${code}`)
    bind(PHONE_OWNER, FORUM, `/bind@test_bot ${code}`)
    expect(await running).toBe(0)

    expect(hubState.hubGroup.load()).toMatchObject({ chatId: GROUP_ID, title: FORUM.title })
    expect(terminal.out).toContain(en.hubInitBound(FORUM.title))
    expect(api.sentTo(OTHER_GROUP.id).map((c) => c.payload.text)).toEqual([en.hubBindNotAForum])
    expect(api.sentTo(FORUM.id).map((c) => c.payload.text)).toEqual([en.hubBindClaimed])
    expect(api.sentTo(STRANGER.id)).toEqual([])
    expect(auditEvents()).toEqual([
      'hub.binding_started',
      'hub.binding_attempt_failed',
      'hub.binding_claimed',
      'hub.binding_confirmed',
      'hub.bound',
    ])
    const persisted =
      JSON.stringify(hubState.db.query('SELECT * FROM audit_log').all()) +
      JSON.stringify(hubState.db.query('SELECT * FROM group_bindings').all())
    expect(persisted).not.toContain(code)
    expect(memory.text).not.toContain(code)
    expect(memory.text).not.toContain(TEST_TOKEN)
  })

  test('five wrong codes cancel the binding', async () => {
    const terminal = new FakeTerminal()
    const running = runHubInit(initDeps(terminal))
    const code = await printedCode(terminal)
    for (let i = 0; i < 5; i++) bind(PHONE_OWNER, FORUM, `/bind@test_bot WRONG${i}AAAAAAAAAAAAAAAA`)
    bind(PHONE_OWNER, FORUM, `/bind@test_bot ${code}`)
    expect(await running).toBe(1)
    expect(terminal.err).toContain(en.hubInitCancelled)
    expect(hubState.hubGroup.load()).toBeUndefined()
    expect(auditEvents()).toContain('hub.binding_cancelled')
  })

  test('an unclaimed code expires', async () => {
    const terminal = new FakeTerminal()
    const expiring: Sleeper = {
      sleep: async (ms) => {
        clock.advance(ms)
        await Bun.sleep(1)
      },
    }
    const running = runHubInit(initDeps(terminal, expiring))
    await printedCode(terminal)
    expect(await running).toBe(1)
    expect(clock.now()).toBeGreaterThanOrEqual(1_700_000_000_000 + PAIRING_TTL_MS)
    expect(terminal.err).toContain(en.hubInitExpired)
    expect(hubState.hubGroup.load()).toBeUndefined()
  })

  test('a bot without the topic right is not bound', async () => {
    api.botMember = { status: 'administrator', can_manage_topics: false, can_pin_messages: true }
    const terminal = new FakeTerminal()
    terminal.confirmations = [true]
    const running = runHubInit(initDeps(terminal))
    const code = await printedCode(terminal)
    bind(PHONE_OWNER, FORUM, `/bind@test_bot ${code}`)
    expect(await running).toBe(1)
    expect(terminal.err).toContain(en.hubInitMissingRights(['can_manage_topics']))
    expect(hubState.hubGroup.load()).toBeUndefined()
  })

  test('nothing starts while another process polls the bot', async () => {
    const lock = new FakeLock()
    lock.holder = { pid: 4242, role: 'channel', startedAt: 0 }
    const terminal = new FakeTerminal()
    expect(await runHubInit(initDeps(terminal, realSleep, lock))).toBe(1)
    expect(terminal.err).toEqual([en.hubInitBusy('channel', 4242)])
    expect(api.callsTo('getUpdates')).toEqual([])
  })
})
