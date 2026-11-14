import { afterEach, expect, test } from 'bun:test'
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
