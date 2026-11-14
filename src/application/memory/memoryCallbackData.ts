import { isMemoryProposalId } from '../../domain/memory/MemoryProposal.ts'

export type MemoryAction = 'approve' | 'reject'

export interface MemoryCallback {
  readonly proposalId: string
  readonly action: MemoryAction
}

/**
 * Version 1 of memory proposal button data: `m1:<proposal id>:<a|r>`, 15
 * bytes. Its own prefix, and every parser is anchored, so a memory button can
 * never be read as a permission (`p1:`), choice (`c1:`), skill (`k1:`) or
 * git (`g1:`) button, nor the other way round.
 */
const CALLBACK_DATA = /^m1:([a-z2-7]{10}):([ar])$/

export function encodeMemoryCallback(proposalId: string, action: MemoryAction): string {
  if (!isMemoryProposalId(proposalId)) throw new Error('invalid memory proposal id')
  return `m1:${proposalId}:${action === 'approve' ? 'a' : 'r'}`
}

/** Strict: anything that is not exactly what we encode is rejected. */
export function parseMemoryCallback(data: string | undefined): MemoryCallback | undefined {
  const match = CALLBACK_DATA.exec(data ?? '')
  const proposalId = match?.[1]
  const action = match?.[2]
  if (proposalId === undefined || action === undefined) return undefined
  return { proposalId, action: action === 'a' ? 'approve' : 'reject' }
}
