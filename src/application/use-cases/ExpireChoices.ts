import type { Choice } from '../../domain/choices/Choice.ts'
import type { ChoicePrompts } from '../choices/ChoicePrompts.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { ChoiceStore } from '../ports/ChoiceStore.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'

export interface ExpireChoicesDeps {
  readonly store: ChoiceStore
  readonly prompts: ChoicePrompts
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/** Time-driven upkeep of open choices; nothing is ever sent to the session from here. */
export class ExpireChoices {
  constructor(private readonly deps: ExpireChoicesDeps) {}

  /** This session's choices past the TTL expire and lose their buttons. */
  async execute(): Promise<number> {
    const now = this.deps.clock.now()
    let count = 0
    for (const choice of this.deps.store.listOpen()) {
      if (choice.session !== this.deps.session || !choice.isDue(now)) continue
      if (await this.#close(choice, choice.expire(now), 'ttl')) count += 1
    }
    return count
  }

  /**
   * Choices of another channel process can no longer reach their session
   * (ADR 0007): cancelled when this process starts polling.
   */
  async expireOrphans(only?: ReadonlySet<string>): Promise<number> {
    const now = this.deps.clock.now()
    let count = 0
    for (const choice of this.deps.store.listOpen()) {
      if (choice.session === this.deps.session || (only !== undefined && !only.has(choice.session)))
        continue
      if (await this.#close(choice, choice.cancel(now), 'orphaned')) count += 1
    }
    return count
  }

  async #close(stored: Choice, next: Choice, reason: 'ttl' | 'orphaned'): Promise<boolean> {
    if (!this.deps.store.update(next, stored.revision)) return false
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: 'system',
      event: 'choice.expired',
      details: { choiceId: stored.id, reason },
    })
    this.deps.logger.info('choice closed without an answer', { choiceId: stored.id, reason })
    await this.deps.prompts.refresh(next, {
      status: next.state === 'expired' ? 'expired' : 'cancelled',
    })
    return true
  }
}
