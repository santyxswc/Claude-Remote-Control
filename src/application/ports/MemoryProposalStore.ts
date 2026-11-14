import type { MemoryProposal } from '../../domain/memory/MemoryProposal.ts'

/**
 * Persists `propose_memory` proposals (F12). Writers race (a tap, the expiry
 * timer), so `update` is a compare-and-set.
 */
export interface MemoryProposalStore {
  put(proposal: MemoryProposal): void
  /** Stores `next` only if the stored revision is still `expectedRevision`. */
  update(next: MemoryProposal, expectedRevision: number): boolean
  findById(id: string): MemoryProposal | undefined
  /** Pending proposals of every session, oldest first. */
  listPending(): readonly MemoryProposal[]
}
