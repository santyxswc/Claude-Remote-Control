import { describe, expect, test } from 'bun:test'
import {
  RATE_LIMIT_BURST,
  RATE_LIMIT_NOTICE_WINDOW_MS,
  RATE_LIMIT_REFILL_MS,
} from '../../src/domain/inboundLimits.ts'
import {
  DEFAULT_RATE_LIMIT,
  InvalidRateLimitPolicyError,
  TokenBucket,
} from '../../src/domain/TokenBucket.ts'

const T0 = 1_700_000_000_000

describe('TokenBucket', () => {
  test('defaults: burst 20, one message every 3 s, one notice per minute', () => {
    expect(DEFAULT_RATE_LIMIT).toEqual({
      burst: RATE_LIMIT_BURST,
      refillMs: RATE_LIMIT_REFILL_MS,
      noticeWindowMs: RATE_LIMIT_NOTICE_WINDOW_MS,
    })
    expect([RATE_LIMIT_BURST, RATE_LIMIT_REFILL_MS]).toEqual([20, 3000])
  })

  test('admits a burst, then drops, notifying only on the first drop', () => {
    const bucket = new TokenBucket()
    for (let i = 0; i < 20; i++) expect(bucket.take('a', T0)).toEqual({ allowed: true })
    expect(bucket.take('a', T0)).toEqual({ allowed: false, notify: true })
    expect(bucket.take('a', T0)).toEqual({ allowed: false, notify: false })
  })

  test('refills one message per interval, never above the burst', () => {
    const bucket = new TokenBucket({ burst: 2, refillMs: 3000, noticeWindowMs: 60_000 })
    bucket.take('a', T0)
    bucket.take('a', T0)
    expect(bucket.take('a', T0 + 2999).allowed).toBe(false)
    expect(bucket.take('a', T0 + 3000).allowed).toBe(true)
    expect(bucket.take('a', T0 + 3001).allowed).toBe(false)
    // A long idle period only restores the burst.
    const later = T0 + 3_600_000
    expect(bucket.take('a', later).allowed).toBe(true)
    expect(bucket.take('a', later).allowed).toBe(true)
    expect(bucket.take('a', later).allowed).toBe(false)
  })

  test('notifies again only after the notice window', () => {
    const bucket = new TokenBucket({ burst: 1, refillMs: 1_000_000, noticeWindowMs: 60_000 })
    bucket.take('a', T0)
    expect(bucket.take('a', T0)).toEqual({ allowed: false, notify: true })
    expect(bucket.take('a', T0 + 59_999)).toEqual({ allowed: false, notify: false })
    expect(bucket.take('a', T0 + 60_000)).toEqual({ allowed: false, notify: true })
  })

  test('senders have separate buckets', () => {
    const bucket = new TokenBucket({ burst: 1, refillMs: 1000, noticeWindowMs: 1000 })
    expect(bucket.take('a', T0).allowed).toBe(true)
    expect(bucket.take('b', T0).allowed).toBe(true)
    expect(bucket.take('a', T0).allowed).toBe(false)
  })

  test('a clock going backwards does not mint tokens', () => {
    const bucket = new TokenBucket({ burst: 1, refillMs: 1000, noticeWindowMs: 1000 })
    bucket.take('a', T0)
    expect(bucket.take('a', T0 - 10_000).allowed).toBe(false)
  })

  test.each([
    [{ burst: 0, refillMs: 1, noticeWindowMs: 1 }],
    [{ burst: 1, refillMs: 0, noticeWindowMs: 1 }],
  ])('rejects an invalid policy %p', (policy) => {
    expect(() => new TokenBucket(policy)).toThrow(InvalidRateLimitPolicyError)
  })
})
