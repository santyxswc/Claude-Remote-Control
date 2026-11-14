import { AwaitPairingClaim } from '../../src/application/use-cases/AwaitPairingClaim.ts'
import { ClaimPairing } from '../../src/application/use-cases/ClaimPairing.ts'
import { ConfirmPairing } from '../../src/application/use-cases/ConfirmPairing.ts'
import { StartPairing } from '../../src/application/use-cases/StartPairing.ts'
import {
  FakeClock,
  FakeHasher,
  FakeSleeper,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  InMemoryPairingStore,
  SequentialRandom,
} from '../fakes.ts'

/** The pairing use cases wired to in-memory fakes. */
export function pairingHarness() {
  const clock = new FakeClock()
  const pairings = new InMemoryPairingStore()
  const allowed = new InMemoryAllowedSenders()
  const audit = new InMemoryAuditLog()
  const hasher = new FakeHasher()
  const sleeper = new FakeSleeper(clock)
  const lifecycle = { pairings, audit }
  return {
    clock,
    pairings,
    allowed,
    audit,
    hasher,
    sleeper,
    start: new StartPairing({
      ...lifecycle,
      random: new SequentialRandom(),
      hasher,
      clock,
      links: { linkFor: (code: string) => `https://t.me/test_bot?start=${code}` },
    }),
    claim: new ClaimPairing({ ...lifecycle, hasher, clock }),
    confirm: new ConfirmPairing({ ...lifecycle, allowed, clock }),
    await: new AwaitPairingClaim({ ...lifecycle, clock, sleeper }),
  }
}
