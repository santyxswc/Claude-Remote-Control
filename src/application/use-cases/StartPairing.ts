import { encodeBase64Url } from '../../domain/base64url.ts'
import { Pairing } from '../../domain/Pairing.ts'
import { encodePairingCode, PAIRING_CODE_BYTES } from '../../domain/pairingCode.ts'
import { ConcurrentPairingUpdateError } from '../errors.ts'
import { commitTransition, expireIfDue, type PairingLifecycleDeps } from '../pairingLifecycle.ts'
import type { Clock } from '../ports/Clock.ts'
import type { PairingLinkBuilder } from '../ports/PairingLinkBuilder.ts'
import type { RandomSource } from '../ports/RandomSource.ts'
import type { SecretHasher } from '../ports/SecretHasher.ts'

const PAIRING_ID_BYTES = 12

export interface StartPairingDeps extends PairingLifecycleDeps {
  readonly random: RandomSource
  readonly hasher: SecretHasher
  readonly clock: Clock
  readonly links: PairingLinkBuilder
}

export interface StartedPairing {
  readonly pairingId: string
  /** The plaintext code. Show it to the user once; never log or store it. */
  readonly code: string
  readonly link: string
  readonly expiresAt: number
}

/** Creates a pending pairing with a fresh 128-bit code, replacing any active one. */
export class StartPairing {
  constructor(private readonly deps: StartPairingDeps) {}

  execute(): StartedPairing {
    const { random, hasher, clock, pairings, links } = this.deps
    const now = clock.now()

    const active = pairings.findActive()
    if (active !== undefined) {
      const current = expireIfDue(this.deps, active, now)
      if (current.isActive) {
        const replaced = current.replace(now)
        const ok = commitTransition(this.deps, replaced, {
          at: now,
          actor: 'terminal',
          event: 'pairing.replaced',
        })
        if (!ok) throw new ConcurrentPairingUpdateError()
      }
    }

    const code = encodePairingCode(random.bytes(PAIRING_CODE_BYTES))
    const pairing = Pairing.start({
      id: encodeBase64Url(random.bytes(PAIRING_ID_BYTES)),
      codeHash: hasher.hash(code),
      now,
    })
    pairings.insert(pairing)
    this.deps.audit.append({
      at: now,
      actor: 'terminal',
      event: 'pairing.started',
      details: { pairingId: pairing.id, expiresAt: pairing.expiresAt },
    })
    return { pairingId: pairing.id, code, link: links.linkFor(code), expiresAt: pairing.expiresAt }
  }
}
