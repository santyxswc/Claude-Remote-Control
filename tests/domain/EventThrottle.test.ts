import { describe, expect, test } from 'bun:test'
import { EventThrottle } from '../../src/domain/EventThrottle.ts'

describe('EventThrottle', () => {
  test('one per key per window, then reports how many were swallowed', () => {
    const throttle = new EventThrottle(60_000)
    expect(throttle.record('a', 0)).toEqual({ emit: true, suppressed: 0 })
    expect(throttle.record('a', 1)).toEqual({ emit: false })
    expect(throttle.record('a', 59_999)).toEqual({ emit: false })
    expect(throttle.record('b', 2)).toEqual({ emit: true, suppressed: 0 })
    expect(throttle.record('a', 60_000)).toEqual({ emit: true, suppressed: 2 })
    expect(throttle.record('a', 120_000)).toEqual({ emit: true, suppressed: 0 })
  })

  test('memory stays bounded under a flood of distinct keys', () => {
    const throttle = new EventThrottle(60_000, 100)
    for (let i = 0; i < 10_000; i++) throttle.record(`k${i}`, i)
    expect(throttle.size).toBeLessThanOrEqual(100)
  })

  test('pruning drops expired keys first', () => {
    const throttle = new EventThrottle(10, 3)
    throttle.record('old', 0)
    throttle.record('b', 20)
    throttle.record('c', 20)
    throttle.record('d', 20) // full: "old" is expired and goes
    expect(throttle.record('b', 21)).toEqual({ emit: false })
    expect(throttle.record('c', 21)).toEqual({ emit: false })
  })
})
