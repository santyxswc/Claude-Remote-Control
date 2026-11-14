import { expect, test } from 'bun:test'
import { PAIRING_TTL_MS } from '../../../src/domain/Pairing.ts'
import { isWellFormedPairingCode } from '../../../src/domain/pairingCode.ts'
import { ALICE } from '../../fakes.ts'
import { pairingHarness } from '../harness.ts'

test('creates a pending pairing with a 128-bit code and a deep link', () => {
  const h = pairingHarness()
  const started = h.start.execute()

  expect(isWellFormedPairingCode(started.code)).toBe(true)
  expect(started.link).toBe(`https://t.me/test_bot?start=${started.code}`)
  expect(started.expiresAt).toBe(h.clock.now() + PAIRING_TTL_MS)
  const stored = h.pairings.findById(started.pairingId)
  expect(stored?.state).toBe('pending')
})

test('stores only the hash of the code, and never audits the code', () => {
  const h = pairingHarness()
  const { code, pairingId } = h.start.execute()

  expect(h.pairings.findById(pairingId)?.codeHash).toBe(h.hasher.hash(code))
  expect(JSON.stringify(h.pairings.findById(pairingId)?.toSnapshot())).not.toContain(`"${code}"`)
  expect(JSON.stringify(h.audit.entries)).not.toContain(code)
  expect(h.audit.entries).toEqual([
    {
      at: h.clock.now(),
      actor: 'terminal',
      event: 'pairing.started',
      details: { pairingId, expiresAt: h.clock.now() + PAIRING_TTL_MS },
    },
  ])
})

test('each pairing gets a fresh code and id', () => {
  const h = pairingHarness()
  const a = h.start.execute()
  const b = h.start.execute()
  expect(a.code).not.toBe(b.code)
  expect(a.pairingId).not.toBe(b.pairingId)
})

test('a new pairing replaces the active one', () => {
  const h = pairingHarness()
  const first = h.start.execute()
  h.claim.execute({ code: first.code, sender: ALICE, sentAt: h.clock.now() })
  const second = h.start.execute()

  expect(h.pairings.findById(first.pairingId)?.state).toBe('cancelled')
  expect(h.pairings.findById(first.pairingId)?.cancelReason).toBe('replaced')
  expect(h.pairings.findActive()?.id).toBe(second.pairingId)
  expect(h.audit.events).toContain('pairing.replaced')
})

test('an outdated active pairing is expired rather than replaced', () => {
  const h = pairingHarness()
  const first = h.start.execute()
  h.clock.advance(PAIRING_TTL_MS)
  h.start.execute()

  expect(h.pairings.findById(first.pairingId)?.state).toBe('expired')
  expect(h.audit.events).toEqual(['pairing.started', 'pairing.expired', 'pairing.started'])
})
