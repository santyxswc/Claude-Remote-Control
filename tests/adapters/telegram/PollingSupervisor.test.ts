import { expect, test } from 'bun:test'
import { PollingSupervisor } from '../../../src/adapters/telegram/PollingSupervisor.ts'
import { FakeLock, FakePoller, ManualEvery, MemoryLogger } from '../../fakes.ts'

const HEARTBEAT = 10
const RETRY = 30

function setup() {
  const lock = new FakeLock()
  const poller = new FakePoller()
  const timers = new ManualEvery()
  const logger = new MemoryLogger()
  const supervisor = new PollingSupervisor({
    lock,
    poller,
    handler: async () => {},
    logger,
    role: 'channel',
    heartbeatMs: HEARTBEAT,
    retryMs: RETRY,
    every: timers.every,
  })
  return { lock, poller, timers, logger, supervisor }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('takes the lock, polls and heartbeats', () => {
  const s = setup()
  s.supervisor.start()
  expect(s.lock.calls).toEqual(['acquire:channel'])
  expect(s.poller.running).toBe(true)
  expect(s.timers.intervals()).toEqual([HEARTBEAT])
  s.timers.tick(HEARTBEAT)
  expect(s.lock.calls).toContain('refresh')
})

test('does not poll while another live process holds the lock, and retries later', () => {
  const s = setup()
  s.lock.holder = { pid: 4242, role: 'cli', startedAt: 0 }
  s.supervisor.start()
  expect(s.poller.starts).toBe(0)
  expect(s.logger.entries[0]).toMatchObject({ fields: { holderPid: 4242, holderRole: 'cli' } })
  expect(s.timers.intervals()).toEqual([RETRY])

  s.lock.holder = undefined
  s.timers.tick(RETRY)
  expect(s.poller.running).toBe(true)
  expect(s.timers.intervals()).toEqual([HEARTBEAT])
})

test('losing the lock stops polling and goes back to retrying', async () => {
  const s = setup()
  s.supervisor.start()
  s.lock.refreshResult = false
  s.timers.tick(HEARTBEAT)
  await flush()
  expect(s.poller.stops).toBe(1)
  expect(s.supervisor.isPolling).toBe(false)
  expect(s.timers.intervals()).toEqual([RETRY])
})

test.each([['unauthorized'], ['conflict']] as const)(
  'a fatal %s exit releases the lock and does not retry',
  async (exit) => {
    const s = setup()
    s.supervisor.start()
    s.poller.end(exit)
    await flush()
    expect(s.lock.calls.at(-1)).toBe('release')
    expect(s.timers.intervals()).toEqual([])
  },
)

test('stop stops polling, releases the lock and cancels timers', async () => {
  const s = setup()
  s.supervisor.start()
  await s.supervisor.stop()
  await flush()
  expect(s.poller.stops).toBe(1)
  expect(s.lock.held).toBe(false)
  expect(s.timers.intervals()).toEqual([])
  s.timers.tick(RETRY)
  expect(s.poller.starts).toBe(1)
})
