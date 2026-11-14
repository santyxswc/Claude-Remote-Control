import { describe, expect, test } from 'bun:test'
import {
  CLOCK_SKEW_TOLERANCE_MS,
  CONFIRMATION_TTL_MS,
  InvalidPairingTransitionError,
  MAX_FAILED_ATTEMPTS,
  PAIRING_TTL_MS,
  Pairing,
} from '../../src/domain/Pairing.ts'
import { ALICE } from '../fakes.ts'

const T0 = 1_000_000
const start = () => Pairing.start({ id: 'p1', codeHash: 'hash', now: T0 })

describe('Pairing', () => {
  test('starts pending, valid for 120 seconds, with no attempts', () => {
    const p = start()
    expect(p.state).toBe('pending')
    expect(p.expiresAt).toBe(T0 + PAIRING_TTL_MS)
    expect(PAIRING_TTL_MS).toBe(120_000)
    expect(p.failedAttempts).toBe(0)
    expect(p.revision).toBe(0)
    expect(p.isActive).toBe(true)
  })

  test('pending -> claimed -> confirmed', () => {
    const claimed = start().claim(ALICE, T0 + 1000)
    expect(claimed.state).toBe('claimed')
    expect(claimed.claimant).toEqual(ALICE)

    const confirmed = claimed.confirm(T0 + 2000)
    expect(confirmed.state).toBe('confirmed')
    expect(confirmed.isActive).toBe(false)
    expect(confirmed.revision).toBe(2)
  })

  test('transitions return new instances and leave the original untouched', () => {
    const p = start()
    p.claim(ALICE, T0)
    expect(p.state).toBe('pending')
  })

  test('a terminal state forgets the code hash', () => {
    const p = start()
    expect(p.codeHash).toBe('hash')
    expect(p.claim(ALICE, T0).confirm(T0).codeHash).toBeUndefined()
    expect(p.replace(T0).codeHash).toBeUndefined()
    expect(p.expire(T0 + PAIRING_TTL_MS).codeHash).toBeUndefined()
  })

  test('is due exactly at the expiry instant, and expires only then', () => {
    const p = start()
    expect(p.isDue(T0 + PAIRING_TTL_MS - 1)).toBe(false)
    expect(() => p.expire(T0 + PAIRING_TTL_MS - 1)).toThrow(InvalidPairingTransitionError)
    expect(p.isDue(T0 + PAIRING_TTL_MS)).toBe(true)
    expect(p.expire(T0 + PAIRING_TTL_MS).state).toBe('expired')
  })

  test('cannot be claimed once due', () => {
    expect(() => start().claim(ALICE, T0 + PAIRING_TTL_MS)).toThrow(InvalidPairingTransitionError)
  })

  test('a claimed pairing must be confirmed within the confirmation window', () => {
    const claimed = start().claim(ALICE, T0 + 100_000)
    // The code's 120 s no longer matter once claimed.
    expect(claimed.isDue(T0 + PAIRING_TTL_MS + 1)).toBe(false)
    const deadline = T0 + 100_000 + CONFIRMATION_TTL_MS
    expect(claimed.isDue(deadline)).toBe(true)
    expect(() => claimed.confirm(deadline)).toThrow(InvalidPairingTransitionError)
    expect(claimed.expire(deadline).state).toBe('expired')
  })

  test('failed attempts are counted and the fifth cancels the pairing', () => {
    let p = start()
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      p = p.recordFailedAttempt(T0)
      expect(p.state).toBe('pending')
      expect(p.failedAttempts).toBe(i)
    }
    p = p.recordFailedAttempt(T0)
    expect(MAX_FAILED_ATTEMPTS).toBe(5)
    expect(p.state).toBe('cancelled')
    expect(p.cancelReason).toBe('too_many_attempts')
    expect(p.failedAttempts).toBe(5)
  })

  test('declining a claim cancels it', () => {
    const p = start().claim(ALICE, T0).decline(T0)
    expect(p.state).toBe('cancelled')
    expect(p.cancelReason).toBe('declined')
  })

  test('replacing cancels a pending or claimed pairing', () => {
    expect(start().replace(T0).cancelReason).toBe('replaced')
    expect(start().claim(ALICE, T0).replace(T0).cancelReason).toBe('replaced')
  })

  test.each([
    ['confirm a pending pairing', (p: Pairing) => p.confirm(T0)],
    ['decline a pending pairing', (p: Pairing) => p.decline(T0)],
    ['claim twice', (p: Pairing) => p.claim(ALICE, T0).claim(ALICE, T0)],
    ['count attempts after a claim', (p: Pairing) => p.claim(ALICE, T0).recordFailedAttempt(T0)],
    ['confirm twice', (p: Pairing) => p.claim(ALICE, T0).confirm(T0).confirm(T0)],
    ['claim a cancelled pairing', (p: Pairing) => p.replace(T0).claim(ALICE, T0)],
    ['revive an expired pairing', (p: Pairing) => p.expire(T0 + PAIRING_TTL_MS).claim(ALICE, T0)],
    ['replace a confirmed pairing', (p: Pairing) => p.claim(ALICE, T0).confirm(T0).replace(T0)],
  ])('refuses to %s', (_label, act) => {
    expect(() => act(start())).toThrow(InvalidPairingTransitionError)
  })

  test('round-trips through a snapshot', () => {
    const p = start().claim(ALICE, T0 + 5)
    expect(Pairing.restore(p.toSnapshot()).toSnapshot()).toEqual(p.toSnapshot())
  })
})

describe('Pairing.predates', () => {
  test('messages sent before the pairing existed, beyond clock skew, predate it', () => {
    const p = start()
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(30_000)
    expect(p.predates(T0 - CLOCK_SKEW_TOLERANCE_MS - 1)).toBe(true)
    expect(p.predates(T0 - CLOCK_SKEW_TOLERANCE_MS)).toBe(false)
    expect(p.predates(T0 + 5_000)).toBe(false)
  })
})
