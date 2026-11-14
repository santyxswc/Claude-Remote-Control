import { expect, test } from 'bun:test'
import { CLAIM_POLL_INTERVAL_MS } from '../../../src/application/use-cases/AwaitPairingClaim.ts'
import { PAIRING_TTL_MS } from '../../../src/domain/Pairing.ts'
import { ALICE } from '../../fakes.ts'
import { pairingHarness } from '../harness.ts'

test('returns as soon as another party claims the pairing', async () => {
  const h = pairingHarness()
  const { code, pairingId } = h.start.execute()
  let naps = 0
  h.sleeper.onSleep = () => {
    if (++naps === 3) h.claim.execute({ code, sender: ALICE, sentAt: h.clock.now() })
  }

  const pairing = await h.await.execute(pairingId)

  expect(pairing.state).toBe('claimed')
  expect(h.sleeper.naps).toEqual([
    CLAIM_POLL_INTERVAL_MS,
    CLAIM_POLL_INTERVAL_MS,
    CLAIM_POLL_INTERVAL_MS,
  ])
})

test('expires the pairing after 120 seconds on a fake clock', async () => {
  const h = pairingHarness()
  const { pairingId } = h.start.execute()

  const pairing = await h.await.execute(pairingId)

  expect(pairing.state).toBe('expired')
  expect(h.sleeper.naps.reduce((a, b) => a + b, 0)).toBe(PAIRING_TTL_MS)
  expect(h.audit.events.at(-1)).toBe('pairing.expired')
})

test('stops waiting when aborted', async () => {
  const h = pairingHarness()
  const { pairingId } = h.start.execute()
  const abort = new AbortController()
  h.sleeper.onSleep = () => abort.abort()

  const pairing = await h.await.execute(pairingId, abort.signal)

  expect(pairing.state).toBe('pending')
  expect(h.sleeper.naps).toHaveLength(1)
})
