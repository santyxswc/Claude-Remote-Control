import type { MemoryProposal } from '../../domain/memory/MemoryProposal.ts'
import type { MemoryPrompts } from '../memory/MemoryPrompts.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { MemoryProposalStore } from '../ports/MemoryProposalStore.ts'

export interface ExpireMemoryProposalsDeps {
  readonly store: MemoryProposalStore
  readonly prompts: MemoryPrompts
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/** Time-driven upkeep of pending proposals (F12): nothing is written, nothing sent to the session. */
export class ExpireMemoryProposals {
  constructor(private readonly deps: ExpireMemoryProposalsDeps) {}

  /** This session's proposals past the TTL expire and lose their buttons. */
  async execute(): Promise<number> {
    const now = this.deps.clock.now()
    let count = 0
    for (const proposal of this.deps.store.listPending()) {
      if (proposal.session !== this.deps.session || !proposal.isDue(now)) continue
      if (await this.#close(proposal, proposal.expire(now), 'ttl')) count += 1
    }
    return count
  }

  /** Proposals of another channel process can no longer be resolved here (ADR 0007). */
  async expireOrphans(only?: ReadonlySet<string>): Promise<number> {
    const now = this.deps.clock.now()
    let count = 0
    for (const proposal of this.deps.store.listPending()) {
      if (
        proposal.session === this.deps.session ||
        (only !== undefined && !only.has(proposal.session))
      )
        continue
      if (await this.#close(proposal, proposal.cancel(now), 'orphaned')) count += 1
    }
    return count
  }

  async #close(
    stored: MemoryProposal,
    next: MemoryProposal,
    reason: 'ttl' | 'orphaned',
  ): Promise<boolean> {
    if (!this.deps.store.update(next, stored.revision)) return false
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: 'system',
      event: 'memory.expired',
      details: { proposalId: stored.id, reason },
    })
    this.deps.logger.info('memory proposal closed without an answer', {
      proposalId: stored.id,
      reason,
    })
    await this.deps.prompts.refresh(next, {
      status: next.state === 'expired' ? 'expired' : 'cancelled',
    })
    return true
  }
}
