import { expect, test } from 'bun:test'
import { MAX_FAILED_ATTEMPTS, PAIRING_TTL_MS } from '../../../src/domain/Pairing.ts'
import { ALICE, MALLORY } from '../../fakes.ts'
import { pairingHarness } from '../harness.ts'

test('the right code claims the pairing for the sender, without granting access', () => {
  const h = pairingHarness()
  const { code, pairingId } = h.start.execute()

  expect(h.claim.execute({ code, sender: ALICE, sentAt: h.clock.now() })).toBe('claimed')

  const pairing = h.pairings.findById(pairingId)
  expect(pairing?.state).toBe('claimed')
  expect(pairing?.claimant).toEqual(ALICE)
  expect(h.allowed.list()).toEqual([])
  expect(h.audit.entries.at(-1)).toEqual({
    at: h.clock.now(),
    actor: `telegram:${ALICE.id}`,
    event: 'pairing.claimed',
    details: { pairingId, senderId: ALICE.id },
  })
})

test('a wrong code is ignored and counted, and never audited verbatim', () => {
  const h = pairingHarness()
  const { pairingId } = h.start.execute()

  expect(h.claim.execute({ code: 'wrong-guess-xyz', sender: MALLORY, sentAt: h.clock.now() })).toBe(
    'ignored',
  )

  expect(h.pairings.findById(pairingId)?.failedAttempts).toBe(1)
  expect(h.audit.entries.at(-1)).toMatchObject({
    event: 'pairing.attempt_failed',
    details: { pairingId, senderId: MALLORY.id, failedAttempts: 1 },
  })
  expect(JSON.stringify(h.audit.entries)).not.toContain('wrong-guess-xyz')
})

test('five wrong codes cancel the pairing; the right code is useless afterwards', () => {
  const h = pairingHarness()
  const { code, pairingId } = h.start.execute()

  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    expect(h.claim.execute({ code: `guess-${i}`, sender: MALLORY, sentAt: h.clock.now() })).toBe(
      'ignored',
    )
  }

  expect(h.pairings.findById(pairingId)?.state).toBe('cancelled')
  expect(h.audit.events.at(-1)).toBe('pairing.cancelled')
  expect(h.claim.execute({ code, sender: ALICE, sentAt: h.clock.now() })).toBe('ignored')
})

test('an expired code is ignored and the pairing is expired', () => {
  const h = pairingHarness()
  const { code, pairingId } = h.start.execute()
  h.clock.advance(PAIRING_TTL_MS)

  expect(h.claim.execute({ code, sender: ALICE, sentAt: h.clock.now() })).toBe('ignored')
  expect(h.pairings.findById(pairingId)?.state).toBe('expired')
  expect(h.audit.events.at(-1)).toBe('pairing.expired')
})

test('a code is single use: a second claim is ignored and not counted', () => {
  const h = pairingHarness()
  const { code, pairingId } = h.start.execute()
  h.claim.execute({ code, sender: ALICE, sentAt: h.clock.now() })

  expect(h.claim.execute({ code, sender: MALLORY, sentAt: h.clock.now() })).toBe('ignored')
  const pairing = h.pairings.findById(pairingId)
  expect(pairing?.claimant).toEqual(ALICE)
  expect(pairing?.failedAttempts).toBe(0)
})

test('without an active pairing nothing happens and nothing is audited', () => {
  const h = pairingHarness()
  expect(h.claim.execute({ code: 'anything', sender: MALLORY, sentAt: h.clock.now() })).toBe(
    'ignored',
  )
  expect(h.audit.entries).toEqual([])
})

test('a lost race with another process is reported as ignored', () => {
  const h = pairingHarness()
  const { code } = h.start.execute()
  h.pairings.update = () => false

  expect(h.claim.execute({ code, sender: ALICE, sentAt: h.clock.now() })).toBe('ignored')
  expect(h.audit.events).toEqual(['pairing.started'])
})

test('backlog sent before the pairing existed neither claims nor counts', () => {
  const h = pairingHarness()
  const { code, pairingId } = h.start.execute()
  const yesterday = h.clock.now() - 24 * 3600_000

  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    expect(h.claim.execute({ code: `old-${i}`, sender: MALLORY, sentAt: yesterday })).toBe(
      'ignored',
    )
  }
  expect(h.claim.execute({ code, sender: MALLORY, sentAt: yesterday })).toBe('ignored')

  expect(h.pairings.findById(pairingId)?.state).toBe('pending')
  expect(h.pairings.findById(pairingId)?.failedAttempts).toBe(0)
  expect(h.audit.events).toEqual(['pairing.started'])
  expect(h.claim.execute({ code, sender: ALICE, sentAt: h.clock.now() })).toBe('claimed')
})
