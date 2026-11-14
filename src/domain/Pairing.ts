import { DomainError } from './DomainError.ts'
import type { SenderProfile } from './Sender.ts'

/** How long a pairing code can be claimed. */
export const PAIRING_TTL_MS = 120_000

/** How long the owner has to confirm at the terminal once a code is claimed. */
export const CONFIRMATION_TTL_MS = 300_000

/** Failed claim attempts that cancel a pairing. */
export const MAX_FAILED_ATTEMPTS = 5

/** Tolerated difference between the chat platform's clock and ours. */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000

/**
 * pending -> claimed -> confirmed, plus the terminal states expired and
 * cancelled. A claim never grants access by itself: only `confirm`, which is
 * driven from the terminal, does.
 */
export type PairingState = 'pending' | 'claimed' | 'confirmed' | 'expired' | 'cancelled'

export type CancelReason = 'too_many_attempts' | 'declined' | 'replaced'

/** Plain data for persistence. Only the hash of the code is ever kept. */
export interface PairingSnapshot {
  readonly id: string
  readonly state: PairingState
  /** Undefined once the pairing reaches a terminal state: a dead code leaves nothing behind. */
  readonly codeHash: string | undefined
  readonly createdAt: number
  readonly expiresAt: number
  readonly failedAttempts: number
  readonly claimant: SenderProfile | undefined
  readonly claimedAt: number | undefined
  readonly endedAt: number | undefined
  readonly cancelReason: CancelReason | undefined
  /** Incremented on every transition; stores use it to detect concurrent writers. */
  readonly revision: number
}

export class InvalidPairingTransitionError extends DomainError {
  constructor(
    readonly from: PairingState,
    readonly action: string,
  ) {
    super(`Cannot ${action} a pairing that is ${from}`)
  }
}

export class Pairing {
  readonly #data: PairingSnapshot

  private constructor(data: PairingSnapshot) {
    this.#data = data
  }

  static start(input: { id: string; codeHash: string; now: number }): Pairing {
    return new Pairing({
      id: input.id,
      state: 'pending',
      codeHash: input.codeHash,
      createdAt: input.now,
      expiresAt: input.now + PAIRING_TTL_MS,
      failedAttempts: 0,
      claimant: undefined,
      claimedAt: undefined,
      endedAt: undefined,
      cancelReason: undefined,
      revision: 0,
    })
  }

  static restore(snapshot: PairingSnapshot): Pairing {
    return new Pairing(snapshot)
  }

  toSnapshot(): PairingSnapshot {
    return this.#data
  }

  get id(): string {
    return this.#data.id
  }

  get state(): PairingState {
    return this.#data.state
  }

  get codeHash(): string | undefined {
    return this.#data.codeHash
  }

  get expiresAt(): number {
    return this.#data.expiresAt
  }

  get failedAttempts(): number {
    return this.#data.failedAttempts
  }

  get claimant(): SenderProfile | undefined {
    return this.#data.claimant
  }

  get cancelReason(): CancelReason | undefined {
    return this.#data.cancelReason
  }

  get revision(): number {
    return this.#data.revision
  }

  /** Pending or claimed: still waiting for someone. */
  get isActive(): boolean {
    return this.state === 'pending' || this.state === 'claimed'
  }

  /**
   * A message sent before this pairing existed (beyond clock skew) cannot be
   * about it: it is backlog queued while nobody was polling, and must neither
   * claim nor count as a failed attempt.
   */
  predates(sentAt: number): boolean {
    return sentAt < this.#data.createdAt - CLOCK_SKEW_TOLERANCE_MS
  }

  /** True when the pairing has outlived its window and must be expired before anything else. */
  isDue(now: number): boolean {
    if (this.state === 'pending') return now >= this.#data.expiresAt
    if (this.state === 'claimed') return now >= (this.#data.claimedAt ?? 0) + CONFIRMATION_TTL_MS
    return false
  }

  expire(now: number): Pairing {
    this.#require('expire', this.isActive && this.isDue(now))
    return this.#end('expired', now, undefined)
  }

  /** The code matched. Records who sent it; access still needs terminal confirmation. */
  claim(sender: SenderProfile, now: number): Pairing {
    this.#require('claim', this.state === 'pending' && !this.isDue(now))
    return this.#next({ state: 'claimed', claimant: sender, claimedAt: now })
  }

  /** A wrong code was sent. The last allowed failure cancels the pairing. */
  recordFailedAttempt(now: number): Pairing {
    this.#require('record a failed attempt on', this.state === 'pending' && !this.isDue(now))
    const failedAttempts = this.#data.failedAttempts + 1
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      return this.#end('cancelled', now, 'too_many_attempts', { failedAttempts })
    }
    return this.#next({ failedAttempts })
  }

  confirm(now: number): Pairing {
    this.#require('confirm', this.state === 'claimed' && !this.isDue(now))
    return this.#end('confirmed', now, undefined)
  }

  decline(now: number): Pairing {
    this.#require('decline', this.state === 'claimed')
    return this.#end('cancelled', now, 'declined')
  }

  /** A newer pairing supersedes this one. */
  replace(now: number): Pairing {
    this.#require('replace', this.isActive)
    return this.#end('cancelled', now, 'replaced')
  }

  #require(action: string, allowed: boolean): void {
    if (!allowed) throw new InvalidPairingTransitionError(this.state, action)
  }

  #end(
    state: 'confirmed' | 'expired' | 'cancelled',
    now: number,
    cancelReason: CancelReason | undefined,
    extra: Partial<PairingSnapshot> = {},
  ): Pairing {
    return this.#next({ ...extra, state, codeHash: undefined, endedAt: now, cancelReason })
  }

  #next(changes: Partial<PairingSnapshot>): Pairing {
    return new Pairing({ ...this.#data, ...changes, revision: this.#data.revision + 1 })
  }
}
