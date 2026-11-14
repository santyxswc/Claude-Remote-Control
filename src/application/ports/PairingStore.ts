import type { Pairing } from '../../domain/Pairing.ts'

/**
 * Persists pairings. Two processes (the channel and the CLI) share the store,
 * so `update` is a compare-and-set on the pairing revision.
 */
export interface PairingStore {
  insert(pairing: Pairing): void
  /**
   * Stores `next` only if the stored revision is still `next.revision - 1`.
   * Returns false when another writer got there first.
   */
  update(next: Pairing): boolean
  findById(id: string): Pairing | undefined
  /** The most recent pending or claimed pairing, if any. */
  findActive(): Pairing | undefined
}
