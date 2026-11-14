/**
 * F14 invariants 3 and 4 at the application level: who may reach a session
 * (the bound group AND an allowlisted sender, never on behalf of a chat) and
 * where things go (only the session that holds the topic; a spoke can only
 * send to, edit in and answer for its own topic).
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { InboundCallback } from '../../../src/application/callbacks/InboundCallback.ts'
import { BindingAuditLog, parseBindCommand } from '../../../src/application/hub/groupBinding.ts'
import {
  HubRegistry,
  LiveSession,
  type SpokeChannel,
  type SpokeEvent,
} from '../../../src/application/hub/HubRegistry.ts'
import { HubRouter } from '../../../src/application/hub/HubRouter.ts'
import {
  SpokeRequestRefusedError,
  TopicBoundGateway,
} from '../../../src/application/hub/TopicBoundGateway.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import { TopicGoneError } from '../../../src/application/ports/ForumTopicGateway.ts'
import type { HubMessageLedger } from '../../../src/application/ports/HubMessageLedger.ts'
import type {
  HubSessionRecord,
  HubSessionStore,
} from '../../../src/application/ports/HubSessionStore.ts'
import type { HubTopic, HubTopicStore } from '../../../src/application/ports/HubTopicStore.ts'
import type { PromptKeyboard } from '../../../src/application/ports/PromptGateway.ts'
import { AssignHubTopic } from '../../../src/application/use-cases/AssignHubTopic.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { EngageBrake } from '../../../src/application/use-cases/EngageBrake.ts'
import { ResumeSession } from '../../../src/application/use-cases/ResumeSession.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import type { PromptRef } from '../../../src/domain/permissions/PermissionRequest.ts'
import { TokenBucket } from '../../../src/domain/TokenBucket.ts'
import {
  ALICE,
  FakeClock,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  InMemoryBrakeFlag,
  MALLORY,
  MemoryLogger,
} from '../../fakes.ts'

const en = messagesFor('en')
const GROUP = '-1001234567890'
const KEYBOARD: PromptKeyboard = [[{ label: 'OK', data: 'x' }]]

class FakeSpoke implements SpokeChannel {
  readonly events: SpokeEvent[] = []
  accept = true
  closed = false
  deliver(event: SpokeEvent): boolean {
    if (!this.accept) return false
    this.events.push(event)
    return true
  }
  close(): void {
    this.closed = true
  }
}

class MemoryLedger implements HubMessageLedger {
  readonly rows = new Map<string, string>()
  record(chatId: string, messageId: string, topicId: string): void {
    this.rows.set(`${chatId}:${messageId}`, topicId)
  }
  topicOf(chatId: string, messageId: string): string | undefined {
    return this.rows.get(`${chatId}:${messageId}`)
  }
  prune(): number {
    return 0
  }
}

/** Records what the hub sends, by target. */
class RecordingOutbound {
  readonly calls: { op: string; target: string; text?: string }[] = []
  failTopic: string | undefined
  #next = 900
  async sendText(target: string, text: string) {
    this.#check(target)
    this.calls.push({ op: 'sendText', target, text })
    return { parts: 1, redactions: 0 }
  }
  async sendTyping(target: string) {
    this.calls.push({ op: 'typing', target })
  }
  async sendPrompt(target: string, text: string): Promise<PromptRef> {
    this.#check(target)
    this.calls.push({ op: 'sendPrompt', target, text })
    return { chatId: target, messageId: String(this.#next++) }
  }
  async editPrompt(ref: PromptRef, text: string) {
    this.calls.push({ op: 'editPrompt', target: `${ref.chatId}#${ref.messageId}`, text })
  }
  async answerCallback(callbackId: string, text?: string) {
    this.calls.push({ op: 'answer', target: callbackId, ...(text === undefined ? {} : { text }) })
  }
  async sendImage(target: string) {
    this.calls.push({ op: 'sendImage', target })
  }
  async sendDocument(target: string) {
    this.calls.push({ op: 'sendDocument', target })
    return { redactions: 0, captionRedactions: 0 } as never
  }
  async sendStatus(target: string, text: string): Promise<PromptRef> {
    this.calls.push({ op: 'sendStatus', target, text })
    return { chatId: target, messageId: String(this.#next++) }
  }
  async editStatus(ref: PromptRef) {
    this.calls.push({ op: 'editStatus', target: `${ref.chatId}#${ref.messageId}` })
  }
  async pinStatus(ref: PromptRef) {
    this.calls.push({ op: 'pinStatus', target: `${ref.chatId}#${ref.messageId}` })
  }
  async unpinStatus(ref: PromptRef) {
    this.calls.push({ op: 'unpinStatus', target: `${ref.chatId}#${ref.messageId}` })
  }
  #check(target: string) {
    if (this.failTopic !== undefined && target.endsWith(`/${this.failTopic}`)) {
      this.failTopic = undefined
      throw new TopicGoneError()
    }
  }
}

let clock: FakeClock
let allowed: InMemoryAllowedSenders
let registry: HubRegistry
let ledger: MemoryLedger
let outbound: RecordingOutbound
let brake: InMemoryBrakeFlag
let privateSeen: InboundMessage[]
let router: HubRouter
let logger: MemoryLogger

function live(
  session: string,
  topicId: string,
  project = `/p/${session}`,
): [LiveSession, FakeSpoke] {
  const channel = new FakeSpoke()
  const entry = new LiveSession(session, topicId, `topic ${topicId}`, project, session, channel)
  registry.add(entry)
  return [entry, channel]
}

function groupMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatId: GROUP,
    messageId: '10',
    chatKind: 'supergroup',
    sender: ALICE,
    text: 'hello',
    sentAt: clock.now(),
    isForum: true,
    chatTitle: 'Projects',
    ...overrides,
  }
}

beforeEach(() => {
  clock = new FakeClock()
  allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, clock.now()))
  registry = new HubRegistry()
  ledger = new MemoryLedger()
  outbound = new RecordingOutbound()
  brake = new InMemoryBrakeFlag()
  privateSeen = []
  logger = new MemoryLogger()
  const brakeDeps = { brake, audit: new InMemoryAuditLog(), clock, logger }
  router = new HubRouter({
    chatId: GROUP,
    authorize: new AuthorizeSender(allowed),
    limiter: new TokenBucket(),
    registry,
    ledger,
    engage: new EngageBrake(brakeDeps),
    resume: new ResumeSession(brakeDeps),
    chat: outbound,
    privateChat: async (message) => void privateSeen.push(message),
    botUsername: 'test_bot',
    messages: en,
    clock,
    logger,
  })
})

describe('invariant 3: the group and the sender', () => {
  test('the owner in a session topic reaches that session, seen as a private chat', async () => {
    const [, a] = live('a', '7')
    const [, b] = live('b', '8')
    await router.handleMessage(groupMessage({ threadId: '7' }))
    expect(b.events).toEqual([])
    expect(a.events).toEqual([
      {
        kind: 'message',
        message: {
          chatId: ALICE.id,
          messageId: '10',
          chatKind: 'private',
          sender: ALICE,
          text: 'hello',
          sentAt: clock.now(),
        },
      },
    ])
  })

  test.each([
    ['a stranger', { sender: MALLORY }],
    ['an anonymous admin', { onBehalfOfChat: true as const }],
    ['another group', { chatId: '-1009999999999' }],
    ['no sender', { sender: undefined }],
  ])('%s reaches nobody and gets no reply', async (_, overrides) => {
    const [, a] = live('a', '7')
    await router.handleMessage(groupMessage({ threadId: '7', ...overrides }))
    await router.handleMessage(groupMessage({ threadId: '7', text: '/stop', ...overrides }))
    expect(a.events).toEqual([])
    expect(outbound.calls).toEqual([])
    expect(brake.status().engaged).toBe(false)
  })

  test('taps are authenticated the same way', async () => {
    const [, a] = live('a', '7')
    ledger.record(GROUP, '55', '7')
    for (const callback of <InboundCallback[]>[
      {
        id: 'c1',
        chatId: GROUP,
        chatKind: 'supergroup',
        messageId: '55',
        threadId: '7',
        sender: MALLORY,
        data: 'x',
      },
      {
        id: 'c2',
        chatId: '-1009999999999',
        chatKind: 'supergroup',
        messageId: '55',
        threadId: '7',
        sender: ALICE,
        data: 'x',
      },
    ]) {
      await router.handleCallback(callback)
    }
    expect(a.events).toEqual([])
    expect(outbound.calls).toEqual([])
  })

  test('the private chat goes to its own chain, never to a session', async () => {
    const [, a] = live('a', '7')
    await router.handleMessage({ ...groupMessage(), chatId: ALICE.id, chatKind: 'private' })
    expect(privateSeen).toHaveLength(1)
    expect(a.events).toEqual([])
  })
})

describe('invariant 4: routing', () => {
  test('the General topic and unknown topics reach no session; the pointer is throttled', async () => {
    const [, a] = live('a', '7')
    await router.handleMessage(groupMessage())
    await router.handleMessage(groupMessage({ threadId: '99' }))
    await router.handleMessage(groupMessage({ threadId: '99' }))
    expect(a.events).toEqual([])
    expect(outbound.calls).toEqual([
      { op: 'sendText', target: GROUP, text: en.hubUseATopic },
      { op: 'sendText', target: `${GROUP}/99`, text: en.hubNoSessionHere },
    ])
  })

  test('a tap goes only to the topic its message was sent to', async () => {
    const [aLive, a] = live('a', '7')
    const [, b] = live('b', '8')
    ledger.record(GROUP, '55', '7')
    // Tapped in topic 8, on a message of topic 7: refused.
    await router.handleCallback({
      id: 'c1',
      chatId: GROUP,
      chatKind: 'supergroup',
      messageId: '55',
      threadId: '8',
      sender: ALICE,
      data: 'p1:abcde:a',
    })
    // A message the hub never sent: refused.
    await router.handleCallback({
      id: 'c2',
      chatId: GROUP,
      chatKind: 'supergroup',
      messageId: '56',
      threadId: '7',
      sender: ALICE,
      data: 'p1:abcde:a',
    })
    expect(a.events).toEqual([])
    expect(b.events).toEqual([])
    expect(outbound.calls.map((c) => c.text)).toEqual([en.hubTapRefused, en.hubTapRefused])

    await router.handleCallback({
      id: 'c3',
      chatId: GROUP,
      chatKind: 'supergroup',
      messageId: '55',
      threadId: '7',
      sender: ALICE,
      data: 'p1:abcde:a',
    })
    expect(b.events).toEqual([])
    expect(a.events).toEqual([
      {
        kind: 'tap',
        callback: {
          id: 'c3',
          chatId: ALICE.id,
          chatKind: 'private',
          messageId: '55',
          sender: ALICE,
          data: 'p1:abcde:a',
        },
      },
    ])
    expect(aLive.routedCallbacks.has('c3')).toBe(true)
  })

  test('/stop engages the brake before any session hears of it, then tells all', async () => {
    const [, a] = live('a', '7')
    const [, b] = live('b', '8')
    let engagedWhenDelivered = false
    a.deliver = (event) => {
      engagedWhenDelivered = brake.status().engaged
      a.events.push(event)
      return true
    }
    await router.handleMessage(groupMessage({ threadId: '8', text: '/stop@test_bot' }))
    expect(engagedWhenDelivered).toBe(true)
    expect(a.events.map((e) => e.kind)).toEqual(['brake'])
    expect(b.events.map((e) => e.kind)).toEqual(['brake'])
    expect(outbound.calls).toEqual([
      { op: 'sendText', target: `${GROUP}/8`, text: en.hubStopped('engaged', 2) },
    ])
    // A command for another bot is not ours.
    await router.handleMessage(groupMessage({ threadId: '8', text: '/resume@other_bot' }))
    expect(brake.status().engaged).toBe(true)
    expect(b.events.filter((e) => e.kind === 'message')).toHaveLength(1)
  })
})

describe('the spoke gateway: one topic only', () => {
  function gateway(session: LiveSession, recreated?: string) {
    return new TopicBoundGateway({
      chatId: GROUP,
      session,
      outbound,
      authorize: new AuthorizeSender(allowed),
      ledger,
      isLocalImage: (path) => path.startsWith('/state/tmp/'),
      download: async (fileId) => ({ path: `/state/tmp/${fileId}`, size: 1 }),
      recreateTopic: async () => recreated,
      clock,
    })
  }

  test('sends go to the session topic; the virtual chat must be an owner', async () => {
    const [aLive] = live('a', '7')
    const g = gateway(aLive)
    await g.sendText(ALICE.id, 'hi')
    await expect(g.sendText(MALLORY.id, 'hi')).rejects.toBeInstanceOf(SpokeRequestRefusedError)
    await expect(g.sendText(GROUP, 'hi')).rejects.toBeInstanceOf(SpokeRequestRefusedError)
    expect(outbound.calls).toEqual([{ op: 'sendText', target: `${GROUP}/7`, text: 'hi' }])
  })

  test('prompts are recorded; edits and pins only for this topic', async () => {
    const [aLive] = live('a', '7')
    const [bLive] = live('b', '8')
    const ref = await gateway(aLive).sendPrompt(ALICE.id, 'Allow?', KEYBOARD)
    expect(ref.chatId).toBe(ALICE.id)
    expect(ledger.topicOf(GROUP, ref.messageId)).toBe('7')
    await expect(gateway(bLive).editPrompt(ref, 'x', KEYBOARD)).rejects.toBeInstanceOf(
      SpokeRequestRefusedError,
    )
    await expect(gateway(bLive).pinStatus(ref)).rejects.toBeInstanceOf(SpokeRequestRefusedError)
    await expect(
      gateway(aLive).editPrompt({ chatId: ALICE.id, messageId: '12345' }, 'x', KEYBOARD),
    ).rejects.toBeInstanceOf(SpokeRequestRefusedError)
    await gateway(aLive).editPrompt(ref, 'Allowed', KEYBOARD)
    expect(outbound.calls.at(-1)).toEqual({
      op: 'editPrompt',
      target: `${GROUP}/7#${ref.messageId}`,
      text: 'Allowed',
    })
  })

  test('taps, files and images: only what was routed to or made by this session', async () => {
    const [aLive] = live('a', '7')
    const g = gateway(aLive)
    await expect(g.answerCallback('c1')).rejects.toBeInstanceOf(SpokeRequestRefusedError)
    aLive.routedCallbacks.add('c1')
    await g.answerCallback('c1', 'ok')
    await expect(g.answerCallback('c1')).rejects.toBeInstanceOf(SpokeRequestRefusedError)
    await expect(g.download('f1', 10)).rejects.toBeInstanceOf(SpokeRequestRefusedError)
    aLive.routedFiles.add('f1')
    expect(await g.download('f1', 10)).toEqual({ path: '/state/tmp/f1', size: 1 })
    const image = { path: '/etc/passwd', filename: 'x.png', as: 'photo' } as never
    await expect(g.sendImage(ALICE.id, image, '')).rejects.toBeInstanceOf(SpokeRequestRefusedError)
  })

  test('a deleted topic is recreated once and the session moves there', async () => {
    const [aLive] = live('a', '7')
    outbound.failTopic = '7'
    await gateway(aLive, '9').sendText(ALICE.id, 'again')
    expect(aLive.topicId).toBe('9')
    expect(outbound.calls).toEqual([{ op: 'sendText', target: `${GROUP}/9`, text: 'again' }])
  })
})

describe('hook routing', () => {
  test('by project, the deepest wins; a Claude session sticks; ambiguity goes nowhere', () => {
    const [app] = live('a', '7', '/p/app')
    const [nested] = live('n', '8', '/p/app/packages/web')
    const [twin1] = live('t1', '10', '/p/twin')
    const [twin2] = live('t2', '11', '/p/twin')
    expect(registry.routeHook('/p/app/src', 'c-app')).toBe(app)
    expect(registry.routeHook('/p/app/packages/web/src', undefined)).toBe(nested)
    expect(registry.routeHook('/elsewhere', 'c-x')).toBeUndefined()
    expect(registry.routeHook(undefined, 'c-app')).toBe(app)
    // Two sessions in one project: without a Claude session id there is no telling.
    expect(registry.routeHook('/p/twin', undefined)).toBeUndefined()
    expect(registry.routeHook('/p/twin', 'c-t')).toBeUndefined()
    twin1.claudeSessions.add('c-t1')
    expect(registry.routeHook('/p/twin', 'c-t2')).toBe(twin2)
    expect(registry.routeHook('/p/twin', 'c-t2')).toBe(twin2)
  })
})

describe('topic assignment', () => {
  class Topics implements HubTopicStore {
    rows: HubTopic[] = []
    listForProject(chatId: string, key: string) {
      return this.rows
        .filter((t) => t.chatId === chatId && t.projectKey === key)
        .sort((x, y) => x.slot - y.slot)
    }
    listAll(chatId: string) {
      return this.rows.filter((t) => t.chatId === chatId)
    }
    insert(topic: HubTopic) {
      this.rows.push(topic)
    }
    replaceTopicId(chatId: string, oldId: string, newId: string) {
      this.rows = this.rows.map((t) =>
        t.chatId === chatId && t.topicId === oldId ? { ...t, topicId: newId } : t,
      )
    }
  }
  class Sessions implements HubSessionStore {
    rows = new Map<string, HubSessionRecord>()
    find(session: string) {
      return this.rows.get(session)
    }
    upsert(session: string, topicId: string) {
      this.rows.set(session, { session, topicId, endedAt: undefined })
    }
    markEnded(session: string, at: number) {
      const row = this.rows.get(session)
      if (row !== undefined) this.rows.set(session, { ...row, endedAt: at })
    }
    listOpen() {
      return [...this.rows.values()].filter((r) => r.endedAt === undefined)
    }
    endedFor(topicId: string) {
      return [...this.rows.values()]
        .filter((r) => r.topicId === topicId && r.endedAt !== undefined)
        .map((r) => r.session)
    }
  }

  test('a project keeps its topic; a second live session gets a suffixed one', async () => {
    const topics = new Topics()
    const sessions = new Sessions()
    const created: string[] = []
    const assign = new AssignHubTopic({
      chatId: GROUP,
      topics,
      sessions,
      registry,
      gateway: {
        createTopic: async (_chat, name) => {
          created.push(name)
          return String(100 + created.length)
        },
      },
      clock,
      logger,
    })
    const first = await assign.execute({ session: 's1', projectKey: '/p/app', projectName: 'app' })
    registry.add(new LiveSession('s1', first.topicId, first.name, '/p/app', 'app', new FakeSpoke()))
    const second = await assign.execute({ session: 's2', projectKey: '/p/app', projectName: 'app' })
    expect([first.name, second.name]).toEqual(['app', 'app (2)'])
    expect(first.reconnect).toBe(false)

    // s1 ends; a third session of the project gets topic 1 back and may clean up after s1.
    const s1 = registry.bySession('s1')
    if (s1 !== undefined) registry.remove(s1)
    sessions.markEnded('s1', clock.now())
    const third = await assign.execute({ session: 's3', projectKey: '/p/app', projectName: 'app' })
    expect(third.topicId).toBe(first.topicId)
    expect(third.ended).toEqual(['s1'])
    expect(created).toEqual(['app', 'app (2)'])

    // s3 reconnects (a hub restart): the same topic, marked as a reconnect.
    const back = await assign.execute({ session: 's3', projectKey: '/p/app', projectName: 'app' })
    expect(back).toMatchObject({ topicId: first.topicId, reconnect: true })
  })
})

describe('group binding', () => {
  test('/bind takes a code, addressed to this bot or to no bot', () => {
    expect(parseBindCommand('/bind ABC', 'test_bot')).toBe('ABC')
    expect(parseBindCommand('/bind@Test_Bot ABC', 'test_bot')).toBe('ABC')
    expect(parseBindCommand('/bind@other_bot ABC', 'test_bot')).toBeUndefined()
    expect(parseBindCommand('/bind', 'test_bot')).toBeUndefined()
    expect(parseBindCommand('/bind A B', 'test_bot')).toBeUndefined()
    expect(parseBindCommand(undefined, 'test_bot')).toBeUndefined()
  })

  test('the audit log names binding events apart from account pairing', () => {
    const inner = new InMemoryAuditLog()
    const log = new BindingAuditLog(inner)
    log.append({ at: 1, actor: 'terminal', event: 'pairing.started', details: {} })
    log.append({ at: 2, actor: 'terminal', event: 'hub.bound', details: {} })
    expect(inner.events).toEqual(['hub.binding_started', 'hub.bound'])
  })
})
