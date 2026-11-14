import type { SenderProfile } from '../../domain/Sender.ts'
import { commitTransition, expireIfDue, type PairingLifecycleDeps } from '../pairingLifecycle.ts'
import type { Clock } from '../ports/Clock.ts'
import type { SecretHasher } from '../ports/SecretHasher.ts'

export interface ClaimPairingDeps extends PairingLifecycleDeps {
  readonly hasher: SecretHasher
  readonly clock: Clock
}

/**
 * `claimed`: the code matched and the pairing now waits for the terminal.
 * `ignored`: anything else (wrong, expired or no code). Callers must not
 * reveal which, so a guesser learns nothing.
 */
export type ClaimOutcome = 'claimed' | 'ignored'

/**
 * Handles a code sent from the chat. A match records the claimant; it never
 * grants access by itself. A mismatch counts as a failed attempt.
 */
export class ClaimPairing {
  constructor(private readonly deps: ClaimPairingDeps) {}

  execute(input: { code: string; sender: SenderProfile; sentAt: number }): ClaimOutcome {
    const { pairings, hasher, clock } = this.deps
    const now = clock.now()
    const actor = `telegram:${input.sender.id}`

    const found = pairings.findActive()
    if (found === undefined) return 'ignored'
    const pairing = expireIfDue(this.deps, found, now)
    if (pairing.state !== 'pending' || pairing.codeHash === undefined) return 'ignored'
    if (pairing.predates(input.sentAt)) return 'ignored'

    if (hasher.matches(input.code, pairing.codeHash)) {
      const claimed = pairing.claim(input.sender, now)
      const ok = commitTransition(this.deps, claimed, {
        at: now,
        actor,
        event: 'pairing.claimed',
        details: { senderId: input.sender.id },
      })
      return ok ? 'claimed' : 'ignored'
    }

    const failed = pairing.recordFailedAttempt(now)
    commitTransition(this.deps, failed, {
      at: now,
      actor,
      event: failed.state === 'cancelled' ? 'pairing.cancelled' : 'pairing.attempt_failed',
      details:
        failed.state === 'cancelled'
          ? { senderId: input.sender.id, reason: 'too_many_attempts' }
          : { senderId: input.sender.id, failedAttempts: failed.failedAttempts },
    })
    return 'ignored'
  }
}
