import { expect, test } from 'bun:test'
import {
  ConcurrentPairingUpdateError,
  PairingNotFoundError,
} from '../../../src/application/errors.ts'
import { CONFIRMATION_TTL_MS } from '../../../src/domain/Pairing.ts'
import { ALICE } from '../../fakes.ts'
import { pairingHarness } from '../harness.ts'

function claimed() {
  const h = pairingHarness()
  const started = h.start.execute()
  h.claim.execute({ code: started.code, sender: ALICE, sentAt: h.clock.now() })
  return { h, pairingId: started.pairingId }
}

test('accepting allowlists the claimant and confirms the pairing', () => {
  const { h, pairingId } = claimed()

  expect(h.confirm.execute({ pairingId, accept: true })).toEqual({
    outcome: 'confirmed',
    sender: ALICE,
  })
  expect(h.allowed.list()).toEqual([{ ...ALICE, addedAt: h.clock.now() }])
  expect(h.pairings.findById(pairingId)?.state).toBe('confirmed')
  expect(h.audit.events.slice(-2)).toEqual(['pairing.confirmed', 'sender.allowed'])
  expect(h.audit.entries.at(-1)).toMatchObject({
    actor: 'terminal',
    details: { senderId: ALICE.id },
  })
})

test('declining cancels the pairing and allows nobody', () => {
  const { h, pairingId } = claimed()

  expect(h.confirm.execute({ pairingId, accept: false })).toEqual({ outcome: 'declined' })
  expect(h.allowed.list()).toEqual([])
  expect(h.pairings.findById(pairingId)?.cancelReason).toBe('declined')
  expect(h.audit.events.at(-1)).toBe('pairing.declined')
})

test('a confirmation after the window expires the pairing instead', () => {
  const { h, pairingId } = claimed()
  h.clock.advance(CONFIRMATION_TTL_MS)

  expect(h.confirm.execute({ pairingId, accept: true })).toEqual({ outcome: 'expired' })
  expect(h.allowed.list()).toEqual([])
})

test('a pairing replaced meanwhile is reported as cancelled', () => {
  const { h, pairingId } = claimed()
  h.start.execute()

  expect(h.confirm.execute({ pairingId, accept: true })).toEqual({ outcome: 'cancelled' })
  expect(h.allowed.list()).toEqual([])
})

test('a lost race grants nothing', () => {
  const { h, pairingId } = claimed()
  h.pairings.update = () => false

  expect(() => h.confirm.execute({ pairingId, accept: true })).toThrow(ConcurrentPairingUpdateError)
  expect(h.allowed.list()).toEqual([])
})

test('an unknown pairing id fails', () => {
  const { h } = claimed()
  expect(() => h.confirm.execute({ pairingId: 'nope', accept: true })).toThrow(PairingNotFoundError)
})
