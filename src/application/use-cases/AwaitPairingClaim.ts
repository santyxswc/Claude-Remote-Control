import type { Pairing } from '../../domain/Pairing.ts'
import { PairingNotFoundError } from '../errors.ts'
import { expireIfDue, type PairingLifecycleDeps } from '../pairingLifecycle.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Sleeper } from '../ports/Sleeper.ts'

export const CLAIM_POLL_INTERVAL_MS = 500

export interface AwaitPairingClaimDeps extends PairingLifecycleDeps {
  readonly clock: Clock
  readonly sleeper: Sleeper
}

/**
 * Waits, by polling the shared store, until the pairing leaves `pending`:
 * claimed (by whichever process polls the chat), expired or cancelled.
 * When `signal` aborts it returns the pairing as it stands.
 */
export class AwaitPairingClaim {
  constructor(private readonly deps: AwaitPairingClaimDeps) {}

  async execute(pairingId: string, signal?: AbortSignal): Promise<Pairing> {
    for (;;) {
      const found = this.deps.pairings.findById(pairingId)
      if (found === undefined) throw new PairingNotFoundError()
      const pairing = expireIfDue(this.deps, found, this.deps.clock.now())
      if (pairing.state !== 'pending' || signal?.aborted) return pairing
      await this.deps.sleeper.sleep(CLAIM_POLL_INTERVAL_MS)
    }
  }
}
