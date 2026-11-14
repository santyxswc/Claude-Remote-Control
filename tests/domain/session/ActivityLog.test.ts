import { expect, test } from 'bun:test'
import { ACTIVITY_STALE_MS, ActivityLog } from '../../../src/domain/session/ActivityLog.ts'

test('unknown until a hook says something', () => {
  const log = new ActivityLog()
  expect(log.current(0)).toBe('unknown')
  expect(log.hooksSeen).toBe(false)
})

test('busy and idle follow the latest signal', () => {
  const log = new ActivityLog()
  log.busy(1_000)
  expect(log.current(1_000)).toBe('busy')
  expect(log.hooksSeen).toBe(true)
  log.idle(2_000)
  expect(log.current(2_000)).toBe('idle')
})

test('a stale signal reverts to unknown, so a crash cannot leave busy forever', () => {
  const log = new ActivityLog()
  log.busy(0)
  expect(log.current(ACTIVITY_STALE_MS)).toBe('busy')
  expect(log.current(ACTIVITY_STALE_MS + 1)).toBe('unknown')
  expect(log.hooksSeen).toBe(true)
})
