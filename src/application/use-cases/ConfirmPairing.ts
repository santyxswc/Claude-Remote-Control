import { allowSender } from '../../domain/AllowedSender.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import { ConcurrentPairingUpdateError, PairingNotFoundError } from '../errors.ts'
import { commitTransition, expireIfDue, type PairingLifecycleDeps } from '../pairingLifecycle.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'
import type { Clock } from '../ports/Clock.ts'

export interface ConfirmPairingDeps extends PairingLifecycleDeps {
  readonly allowed: AllowedSenderStore
  readonly clock: Clock
}

export type ConfirmOutcome =
  | { readonly outcome: 'confirmed'; readonly sender: SenderProfile }
  | { readonly outcome: 'declined' }
  | { readonly outcome: 'expired' }
  /** Replaced by a newer pairing, or otherwise no longer waiting for confirmation. */
  | { readonly outcome: 'cancelled' }

/**
 * The owner's answer at the terminal. Only an acceptance adds the claimant to
 * the allowlist; the pairing is marked confirmed first, so a crash in between
 * leaves access denied rather than granted twice.
 */
export class ConfirmPairing {
  constructor(private readonly deps: ConfirmPairingDeps) {}

  execute(input: { pairingId: string; accept: boolean }): ConfirmOutcome {
    const { pairings, allowed, clock } = this.deps
    const now = clock.now()

    const found = pairings.findById(input.pairingId)
    if (found === undefined) throw new PairingNotFoundError()
    const pairing = expireIfDue(this.deps, found, now)
    if (pairing.state === 'expired') return { outcome: 'expired' }
    if (pairing.state !== 'claimed') return { outcome: 'cancelled' }

    if (!input.accept) {
      const declined = pairing.decline(now)
      const entry = { at: now, actor: 'terminal', event: 'pairing.declined' } as const
      if (!commitTransition(this.deps, declined, entry)) throw new ConcurrentPairingUpdateError()
      return { outcome: 'declined' }
    }

    const confirmed = pairing.confirm(now)
    const sender = confirmed.claimant
    if (sender === undefined) throw new PairingNotFoundError()
    const details = { senderId: sender.id }
    const entry = { at: now, actor: 'terminal', event: 'pairing.confirmed', details } as const
    if (!commitTransition(this.deps, confirmed, entry)) throw new ConcurrentPairingUpdateError()
    allowed.add(allowSender(sender, now))
    this.deps.audit.append({ at: now, actor: 'terminal', event: 'sender.allowed', details })
    return { outcome: 'confirmed', sender }
  }
}
