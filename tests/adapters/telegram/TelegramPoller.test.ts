import { afterEach, describe, expect, test } from 'bun:test'
import { ALLOWED_UPDATES, TelegramPoller } from '../../../src/adapters/telegram/TelegramPoller.ts'
import type { InboundCallback } from '../../../src/application/callbacks/InboundCallback.ts'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import { MemoryLogger } from '../../fakes.ts'
import { FakeTelegramApi, PHONE_OWNER, TEST_TOKEN } from '../../fakeTelegram.ts'

let poller: TelegramPoller | undefined

afterEach(async () => {
  await poller?.stop()
  poller = undefined
})

function setup(options: { maxConflicts?: number } = {}) {
  const api = new FakeTelegramApi()
  const logger = new MemoryLogger()
  const naps: number[] = []
  poller = new TelegramPoller({
    token: TEST_TOKEN,
    logger,
    fetch: api.fetch,
    pollTimeoutSeconds: 1,
    maxConflicts: options.maxConflicts ?? 3,
    sleep: async (ms) => {
      naps.push(ms)
    },
  })
  const received: InboundMessage[] = []
  return {
    api,
    logger,
    naps,
    poller,
    received,
    handler: async (m: InboundMessage) => void received.push(m),
  }
}

async function until(probe: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error('condition not reached')
}

test('long-polls with only the update types we use and maps messages', async () => {
  const s = setup()
  void s.poller.start(s.handler)
  s.api.sendText(PHONE_OWNER, 'hello')
  await until(() => s.received.length === 1)

  expect(s.received[0]).toEqual({
    chatId: '5000000001',
    messageId: '1',
    chatKind: 'private',
    sender: { id: '5000000001', username: 'owner', displayName: 'Owner' },
    text: 'hello',
    sentAt: 1_700_000_000_000,
  })
  expect(s.api.calls[0]?.method).toBe('getMe')
  expect(s.api.callsTo('getUpdates')[0]?.payload).toMatchObject({
    offset: 0,
    timeout: 1,
    allowed_updates: [...ALLOWED_UPDATES],
  })
  expect(ALLOWED_UPDATES).toEqual(['message', 'callback_query'])
})

test('advances the offset and confirms processed updates on stop', async () => {
  const s = setup()
  void s.poller.start(s.handler)
  const id = s.api.sendText(PHONE_OWNER, 'one')
  await until(() => s.received.length === 1)
  await s.api.waitForPolls(2)
  expect(s.api.callsTo('getUpdates')[1]?.payload.offset).toBe(id + 1)

  await s.poller.stop()
  expect(s.api.callsTo('getUpdates').at(-1)?.payload).toEqual({
    offset: id + 1,
    limit: 1,
    timeout: 0,
  })
})

test('stop resolves the start promise with "stopped"', async () => {
  const s = setup()
  const done = s.poller.start(s.handler)
  await s.api.waitForPolls(1)
  await s.poller.stop()
  expect(await done).toBe('stopped')
})

test('a 401 stops polling at once, without retry and without the token in logs', async () => {
  const s = setup()
  s.api.script('getMe', { ok: false, error_code: 401, description: 'Unauthorized' })

  expect(await s.poller.start(s.handler)).toBe('unauthorized')
  expect(s.api.callsTo('getUpdates')).toHaveLength(0)
  expect(s.naps).toEqual([])
  expect(s.logger.entries.at(-1)).toMatchObject({ level: 'error' })
  expect(s.logger.text).not.toContain(TEST_TOKEN)
})

test('a persistent 409 Conflict gives up after the configured attempts, with backoff', async () => {
  const s = setup({ maxConflicts: 3 })
  const conflict = {
    ok: false,
    error_code: 409,
    description: 'Conflict: terminated by other getUpdates request',
  } as const
  s.api.script('getUpdates', conflict, conflict, conflict)

  expect(await s.poller.start(s.handler)).toBe('conflict')
  expect(s.naps).toEqual([1000, 2000])
  expect(s.logger.text).not.toContain(TEST_TOKEN)
})

test('a transient conflict is retried and polling recovers', async () => {
  const s = setup({ maxConflicts: 3 })
  s.api.script('getUpdates', { ok: false, error_code: 409, description: 'Conflict' })
  void s.poller.start(s.handler)
  s.api.sendText(PHONE_OWNER, 'after conflict')
  await until(() => s.received.length === 1)
  expect(s.naps).toEqual([1000])
})

test('network errors are retried and logged with the token scrubbed from URLs', async () => {
  const s = setup()
  // A fetch error whose message includes the request URL, token and all.
  s.api.script('getUpdates', {
    networkError: `connect ECONNREFUSED https://api.telegram.org/bot${TEST_TOKEN}/getUpdates`,
  })
  void s.poller.start(s.handler)
  s.api.sendText(PHONE_OWNER, 'back online')
  await until(() => s.received.length === 1)

  expect(s.logger.entries.some((e) => e.message === 'telegram polling failed; retrying')).toBe(true)
  expect(s.logger.text).not.toContain(TEST_TOKEN)
  expect(s.logger.text).not.toContain('AAHtestTOKEN')
})

test('a failing handler is logged and polling continues', async () => {
  const s = setup()
  let calls = 0
  void s.poller.start(async (m) => {
    calls += 1
    if (calls === 1) throw new Error(`boom ${TEST_TOKEN}`)
    s.received.push(m)
  })
  s.api.sendText(PHONE_OWNER, 'first')
  await until(() => calls === 1)
  s.api.sendText(PHONE_OWNER, 'second')
  await until(() => s.received.length === 1)

  expect(s.received[0]?.text).toBe('second')
  expect(s.logger.entries.find((e) => e.message === 'inbound handler failed')).toBeDefined()
  expect(s.logger.text).not.toContain(TEST_TOKEN)
})

test('refuses to start twice', async () => {
  const s = setup()
  void s.poller.start(s.handler)
  expect(() => s.poller.start(s.handler)).toThrow('already polling')
})

test('only calls the fake API: every request goes to api.telegram.org through the injected fetch', async () => {
  const s = setup()
  void s.poller.start(s.handler)
  await s.api.waitForPolls(1)
  expect(s.api.urls.every((url) => url.startsWith('https://api.telegram.org/bot'))).toBe(true)
})

test('button taps go to the callback handler, not the message handler', async () => {
  const s = setup()
  const taps: InboundCallback[] = []
  void s.poller.start(s.handler, async (c) => void taps.push(c))
  s.api.tap(PHONE_OWNER, 7, 'p1:abcde:a')
  await until(() => taps.length === 1)
  expect(taps[0]).toMatchObject({
    chatId: String(PHONE_OWNER.id),
    chatKind: 'private',
    data: 'p1:abcde:a',
  })
  expect(s.received).toEqual([])
})

describe('M1: slow work never holds back later updates', () => {
  /** A real but short, abortable nap: the re-check interval while work is in flight. */
  const shortSleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(ms, 10))
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    })

  function lanes() {
    const api = new FakeTelegramApi()
    const logger = new MemoryLogger()
    poller = new TelegramPoller({
      token: TEST_TOKEN,
      logger,
      fetch: api.fetch,
      pollTimeoutSeconds: 1,
      sleep: shortSleep,
      isUrgent: (message) => message.text === '/stop',
    })
    const started: string[] = []
    const finished: string[] = []
    const gates = new Map<string, () => void>()
    /** Each text waits for its gate when one is set (a controlled promise, no real delay). */
    const handler = async (m: InboundMessage) => {
      started.push(m.text ?? '')
      if (m.text?.startsWith('slow'))
        await new Promise<void>((open) => gates.set(m.text ?? '', open))
      finished.push(m.text ?? '')
    }
    return { api, logger, poller, started, finished, gates, handler }
  }

  test('/stop is handled while an earlier update of the same chat is still pending', async () => {
    const s = lanes()
    void s.poller.start(s.handler)
    s.api.sendText(PHONE_OWNER, 'slow capture')
    s.api.sendText(PHONE_OWNER, '/stop')
    await until(() => s.finished.includes('/stop'))
    expect(s.finished).toEqual(['/stop'])
    s.gates.get('slow capture')?.()
    await until(() => s.finished.length === 2)
  })

  test('a /stop sent later still gets through while the slow one is pending', async () => {
    const s = lanes()
    void s.poller.start(s.handler)
    s.api.sendText(PHONE_OWNER, 'slow one')
    await until(() => s.started.includes('slow one'))
    s.api.sendText(PHONE_OWNER, '/stop')
    await until(() => s.finished.includes('/stop'))
    expect(s.finished).toEqual(['/stop'])
    s.gates.get('slow one')?.()
  })

  test('ordinary messages of one chat keep their order; nothing is handled twice', async () => {
    const s = lanes()
    void s.poller.start(s.handler)
    s.api.sendText(PHONE_OWNER, 'slow first')
    s.api.sendText(PHONE_OWNER, 'second')
    s.api.sendText(PHONE_OWNER, 'third')
    await until(() => s.started.includes('slow first'))
    // Polling goes on (no wait behind the slow handler), but the chat's order holds.
    await s.api.waitForPolls(4)
    expect(s.started).toEqual(['slow first'])
    s.gates.get('slow first')?.()
    await until(() => s.finished.length === 3)
    await until(() => s.api.idle)
    expect(s.started).toEqual(['slow first', 'second', 'third'])
    expect(s.finished).toEqual(['slow first', 'second', 'third'])
  })

  test('pending updates are not confirmed: the offset stays at the oldest one in flight', async () => {
    const s = lanes()
    void s.poller.start(s.handler)
    const slow = s.api.sendText(PHONE_OWNER, 'slow pending')
    await until(() => s.started.includes('slow pending'))
    const polls = s.api.callsTo('getUpdates').length
    await s.api.waitForPolls(polls + 2)
    expect(s.api.callsTo('getUpdates').at(-1)?.payload.offset).toBe(slow)
    s.gates.get('slow pending')?.()
    await until(() => s.api.idle)
    expect(s.api.callsTo('getUpdates').at(-1)?.payload.offset).toBe(slow + 1)
  })

  test('stop waits for handlers in flight, then confirms everything', async () => {
    const s = lanes()
    void s.poller.start(s.handler)
    const id = s.api.sendText(PHONE_OWNER, 'slow at shutdown')
    await until(() => s.started.includes('slow at shutdown'))
    const stopping = s.poller.stop()
    s.gates.get('slow at shutdown')?.()
    await stopping
    expect(s.finished).toEqual(['slow at shutdown'])
    expect(s.api.callsTo('getUpdates').at(-1)?.payload).toEqual({
      offset: id + 1,
      limit: 1,
      timeout: 0,
    })
  })
})
