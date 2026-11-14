/** When the pinned status is edited (F9), on a fake clock. */
import { describe, expect, test } from 'bun:test'
import {
  STATUS_DEBOUNCE_MS,
  STATUS_GLOBAL_BURST,
  STATUS_GLOBAL_REFILL_MS,
  STATUS_MAX_WAIT_MS,
  STATUS_MIN_INTERVAL_MS,
  StatusUpdatePolicy,
} from '../../../src/domain/status/StatusUpdatePolicy.ts'

/** A policy whose chat `a` last showed `v0` at t=0, long enough ago. */
function settledPolicy(start = 100_000) {
  const policy = new StatusUpdatePolicy()
  policy.sent('a', 'v0', start - STATUS_MIN_INTERVAL_MS * 10)
  return policy
}

describe('StatusUpdatePolicy', () => {
  test('trailing debounce: due once nothing changed for the debounce time', () => {
    const policy = settledPolicy()
    const t = 100_000
    policy.observe('a', 'v1', t)
    expect(policy.due('a', t)).toBeUndefined()
    expect(policy.due('a', t + STATUS_DEBOUNCE_MS - 1)).toBeUndefined()
    // Another change restarts the wait and replaces the pending text.
    policy.observe('a', 'v2', t + 1_500)
    expect(policy.due('a', t + STATUS_DEBOUNCE_MS)).toBeUndefined()
    expect(policy.due('a', t + 1_500 + STATUS_DEBOUNCE_MS)).toBe('v2')
  })

  test('the same render again does not restart the debounce', () => {
    const policy = settledPolicy()
    policy.observe('a', 'v1', 100_000)
    policy.observe('a', 'v1', 101_000)
    policy.observe('a', 'v1', 101_900)
    expect(policy.due('a', 100_000 + STATUS_DEBOUNCE_MS)).toBe('v1')
  })

  test('a status that never settles is still sent after the max wait', () => {
    const policy = settledPolicy()
    const t = 100_000
    let due: string | undefined
    let at = t
    for (; at <= t + STATUS_MAX_WAIT_MS && due === undefined; at += 1_000) {
      policy.observe('a', `v${at}`, at)
      due = policy.due('a', at)
    }
    expect(due).toBe(`v${t + STATUS_MAX_WAIT_MS}`)
  })

  test('an unchanged render never edits: no heartbeat', () => {
    const policy = settledPolicy()
    for (let at = 100_000; at < 200_000; at += 1_000) {
      policy.observe('a', 'v0', at)
      expect(policy.due('a', at)).toBeUndefined()
    }
  })

  test('a change that comes back to the shown text cancels the edit', () => {
    const policy = settledPolicy()
    policy.observe('a', 'v1', 100_000)
    policy.observe('a', 'v0', 100_500)
    expect(policy.due('a', 110_000)).toBeUndefined()
  })

  test('at most one edit per chat per interval', () => {
    const policy = settledPolicy()
    policy.observe('a', 'v1', 100_000)
    expect(policy.due('a', 102_000)).toBe('v1')
    policy.sent('a', 'v1', 102_000)
    policy.observe('a', 'v2', 102_100)
    expect(policy.due('a', 106_999)).toBeUndefined()
    expect(policy.due('a', 102_000 + STATUS_MIN_INTERVAL_MS)).toBe('v2')
  })

  test('the first edit after a send waits the interval', () => {
    const policy = new StatusUpdatePolicy()
    policy.sent('a', 'v0', 0)
    policy.observe('a', 'v1', 0)
    expect(policy.due('a', STATUS_DEBOUNCE_MS)).toBeUndefined()
    expect(policy.due('a', STATUS_MIN_INTERVAL_MS)).toBe('v1')
  })

  test('a chat never seen has nothing due', () => {
    expect(new StatusUpdatePolicy().due('x', 0)).toBeUndefined()
  })

  test('a flood wait holds back every chat until it is over, then the latest render goes', () => {
    const policy = settledPolicy()
    policy.sent('b', 'w0', 0)
    policy.observe('a', 'v1', 100_000)
    policy.observe('b', 'w1', 100_000)
    policy.floodWait('a', 130_000)
    for (const at of [102_000, 110_000, 129_999]) {
      policy.observe('a', 'v-latest', 101_000)
      expect(policy.due('a', at)).toBeUndefined()
      expect(policy.due('b', at)).toBeUndefined()
    }
    expect(policy.due('a', 130_000)).toBe('v-latest')
    expect(policy.due('b', 130_000)).toBe('w1')
  })

  test('a failed edit keeps the render pending and waits the interval', () => {
    const policy = settledPolicy()
    policy.observe('a', 'v1', 100_000)
    expect(policy.due('a', 102_000)).toBe('v1')
    policy.failed('a', 102_000)
    expect(policy.due('a', 103_000)).toBeUndefined()
    expect(policy.due('a', 102_000 + STATUS_MIN_INTERVAL_MS)).toBe('v1')
  })

  test('a global budget across chats', () => {
    const policy = new StatusUpdatePolicy()
    const chats = Array.from({ length: STATUS_GLOBAL_BURST + 3 }, (_, i) => `c${i}`)
    for (const chat of chats) {
      policy.sent(chat, 'old', 0)
      policy.observe(chat, 'new', 50_000)
    }
    const now = 60_000
    const granted = chats.filter((chat) => policy.due(chat, now) !== undefined)
    expect(granted).toHaveLength(STATUS_GLOBAL_BURST)
    for (const chat of granted) policy.sent(chat, 'new', now)
    const rest = chats.filter((chat) => !granted.includes(chat))
    expect(rest.filter((chat) => policy.due(chat, now + 1) !== undefined)).toHaveLength(0)
    expect(
      rest.filter((chat) => policy.due(chat, now + STATUS_GLOBAL_REFILL_MS) !== undefined),
    ).toHaveLength(1)
  })

  test('forget drops the chat', () => {
    const policy = settledPolicy()
    policy.observe('a', 'v1', 100_000)
    policy.forget('a')
    expect(policy.due('a', 200_000)).toBeUndefined()
  })
})
