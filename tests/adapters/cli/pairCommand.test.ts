import { expect, test } from 'bun:test'
import { type PairCommandDeps, runPair } from '../../../src/adapters/cli/pairCommand.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { createInboundPipeline } from '../../../src/application/pipeline/createInboundPipeline.ts'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { PAIRING_TTL_MS } from '../../../src/domain/Pairing.ts'
import { pairingHarness } from '../../application/harness.ts'
import {
  ALICE,
  FakeChatGateway,
  FakeLock,
  FakePoller,
  FakeTerminal,
  MALLORY,
  ManualEvery,
  MemoryLogger,
} from '../../fakes.ts'

const en = messagesFor('en')
const HEARTBEAT = 10

function setup() {
  const h = pairingHarness()
  const lock = new FakeLock()
  const poller = new FakePoller()
  const terminal = new FakeTerminal()
  const timers = new ManualEvery()
  const chat = new FakeChatGateway()
  const logger = new MemoryLogger()
  const deps: PairCommandDeps = {
    terminal,
    messages: en,
    clock: h.clock,
    renderQr: (text) => `QR<${text}>`,
    every: timers.every,
    heartbeatMs: HEARTBEAT,
    session: {
      startPairing: h.start,
      awaitClaim: h.await,
      confirmPairing: h.confirm,
      lock,
      createPoller: () => poller,
      pipeline: createInboundPipeline({
        claimPairing: h.claim,
        authorizeSender: new AuthorizeSender(h.allowed),
        chat,
        messages: en,
        logger,
        clock: h.clock,
      }),
    },
  }
  const code = () => {
    const link = terminal.out.find((line) => line.startsWith('https://t.me/test_bot?start='))
    if (link === undefined) throw new Error('no link printed')
    return link.slice(link.indexOf('=') + 1)
  }
  const fromPhone = (sender: typeof ALICE, text: string): InboundMessage => ({
    chatId: sender.id,
    messageId: '1',
    chatKind: 'private',
    sender,
    text,
    sentAt: h.clock.now(),
  })
  return { h, lock, poller, terminal, timers, chat, logger, deps, code, fromPhone }
}

test('without a configured bot it says so and fails', async () => {
  const s = setup()
  expect(await runPair({ ...s.deps, session: undefined })).toBe(1)
  expect(s.terminal.err).toEqual([en.notConfigured])
})

test('polls itself when no channel holds the lock, then asks and allowlists on yes', async () => {
  const s = setup()
  s.h.sleeper.onSleep = () => {
    if (s.h.sleeper.naps.length === 1)
      void s.poller.deliver(s.fromPhone(ALICE, `/start ${s.code()}`))
  }
  s.terminal.onConfirm = () => {
    // Polling stopped before the question: nobody else can claim meanwhile.
    expect(s.poller.running).toBe(false)
  }
  s.terminal.confirmations = [true]

  expect(await runPair(s.deps)).toBe(0)

  expect(s.lock.calls[0]).toBe('acquire:cli')
  expect(s.lock.calls.at(-1)).toBe('release')
  expect(s.poller.starts).toBe(1)
  expect(s.timers.intervals()).toEqual([])
  expect(s.terminal.out).toEqual([
    en.pairScan,
    `QR<https://t.me/test_bot?start=${s.code()}>`,
    `https://t.me/test_bot?start=${s.code()}`,
    en.pairExpiresIn(120),
    en.pairPollingHere,
    en.pairClaimedBy(ALICE),
    en.pairConfirmed(ALICE),
  ])
  expect(s.terminal.prompts).toEqual([en.pairConfirmPrompt])
  expect(s.h.allowed.list().map((a) => a.id)).toEqual([ALICE.id])
  expect(s.chat.sent).toEqual([{ chatId: ALICE.id, text: en.pairingClaimedReply }])
  expect(s.logger.text).not.toContain(s.code())
})

test('heartbeats the lock while it polls', async () => {
  const s = setup()
  s.h.sleeper.onSleep = () => {
    if (s.h.sleeper.naps.length === 1) {
      s.timers.tick(HEARTBEAT)
      void s.poller.deliver(s.fromPhone(ALICE, `/start ${s.code()}`))
    }
  }
  s.terminal.confirmations = [true]
  await runPair(s.deps)
  expect(s.lock.calls).toContain('refresh')
})

test('only watches the database when the channel process polls', async () => {
  const s = setup()
  s.lock.holder = { pid: 777, role: 'channel', startedAt: 0 }
  // The channel process records the claim in the shared store.
  s.h.sleeper.onSleep = () => {
    if (s.h.sleeper.naps.length === 2)
      s.h.claim.execute({ code: s.code(), sender: ALICE, sentAt: s.h.clock.now() })
  }
  s.terminal.confirmations = [true]

  expect(await runPair(s.deps)).toBe(0)

  expect(s.poller.starts).toBe(0)
  expect(s.lock.calls).toEqual(['acquire:cli'])
  expect(s.terminal.out).toContain(en.pairUsingChannel)
  expect(s.h.allowed.has(ALICE.id)).toBe(true)
})

test('refuses to run next to another pair command', async () => {
  const s = setup()
  s.lock.holder = { pid: 555, role: 'cli', startedAt: 0 }
  expect(await runPair(s.deps)).toBe(1)
  expect(s.terminal.err).toEqual([en.pairAnotherInProgress(555)])
  expect(s.h.pairings.all()).toEqual([])
})

test('a stranger with a wrong code gets silence; the claimant shown is the real one', async () => {
  const s = setup()
  s.h.sleeper.onSleep = () => {
    const nap = s.h.sleeper.naps.length
    if (nap === 1) void s.poller.deliver(s.fromPhone(MALLORY, '/start AAAAAAAAAAAAAAAAAAAAAA'))
    if (nap === 2) void s.poller.deliver(s.fromPhone(MALLORY, 'let me in'))
    if (nap === 3) void s.poller.deliver(s.fromPhone(ALICE, `/start ${s.code()}`))
  }
  s.terminal.confirmations = [true]

  expect(await runPair(s.deps)).toBe(0)
  expect(s.chat.sent.map((m) => m.chatId)).toEqual([ALICE.id])
  expect(s.terminal.out).toContain(en.pairClaimedBy(ALICE))
  expect(s.h.allowed.has(MALLORY.id)).toBe(false)
})

test('answering no allows nobody', async () => {
  const s = setup()
  s.h.sleeper.onSleep = () => void s.poller.deliver(s.fromPhone(ALICE, `/start ${s.code()}`))
  s.terminal.confirmations = [false]

  expect(await runPair(s.deps)).toBe(1)
  expect(s.terminal.out.at(-1)).toBe(en.pairDeclined)
  expect(s.h.allowed.list()).toEqual([])
})

test('nobody claims within 120 seconds: expired, on a fake clock', async () => {
  const s = setup()
  const started = s.h.clock.now()

  expect(await runPair(s.deps)).toBe(1)

  expect(s.terminal.err).toEqual([en.pairExpired])
  expect(s.h.clock.now() - started).toBe(PAIRING_TTL_MS)
  expect(s.poller.stops).toBe(1)
  expect(s.lock.held).toBe(false)
})

test('a rejected token while polling ends the command with a clear message', async () => {
  const s = setup()
  s.h.sleeper.onSleep = () => s.poller.end('unauthorized')

  expect(await runPair(s.deps)).toBe(1)
  expect(s.terminal.err).toEqual([en.pairTokenRejected])
  expect(s.lock.held).toBe(false)
})

test('wrong codes queued before the pairing (backlog) cannot cancel it', async () => {
  const s = setup()
  const queuedLongAgo = s.h.clock.now() - 3600_000
  s.h.sleeper.onSleep = () => {
    if (s.h.sleeper.naps.length !== 1) return
    for (let i = 0; i < 5; i++) {
      void s.poller.deliver({ ...s.fromPhone(MALLORY, `/start old${i}`), sentAt: queuedLongAgo })
    }
    void s.poller.deliver(s.fromPhone(ALICE, `/start ${s.code()}`))
  }
  s.terminal.confirmations = [true]

  expect(await runPair(s.deps)).toBe(0)
  expect(s.h.allowed.has(ALICE.id)).toBe(true)
})
