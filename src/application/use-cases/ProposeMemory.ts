import {
  checkMemoryLines,
  type MemoryLineProblem,
  MemoryProposal,
  memoryProposalIdFrom,
} from '../../domain/memory/MemoryProposal.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import { PromptRedactedError, PromptTooLongError } from '../errors.ts'
import type { MemoryPrompts } from '../memory/MemoryPrompts.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { MemoryProposalStore } from '../ports/MemoryProposalStore.ts'
import type { RandomSource } from '../ports/RandomSource.ts'
import { type AuthorizeReplyTarget, auditableChatId } from './AuthorizeReplyTarget.ts'

/** What Claude passed to `propose_memory`. Every field is untrusted. */
export interface ProposeMemoryRequest {
  readonly chatId: string
  readonly lines: readonly string[]
}

/** Why a proposal could not be shown exactly as it would be written. */
export type ProposalProblem = MemoryLineProblem | 'contains_secret' | 'too_long_for_one_message'

export type ProposeMemoryOutcome =
  | { readonly status: 'proposed'; readonly proposalId: string }
  | { readonly status: 'refused'; readonly reason: 'chat_not_allowed' | 'not_polling' }
  | { readonly status: 'invalid'; readonly problem: ProposalProblem; readonly line?: number }
  | { readonly status: 'failed'; readonly error: string }

export interface ProposeMemoryDeps {
  readonly store: MemoryProposalStore
  readonly prompts: MemoryPrompts
  /** The same chat rule as `reply`, without extra chats: buttons exist only on Telegram. */
  readonly target: AuthorizeReplyTarget
  readonly random: RandomSource
  /** True while this process polls the bot, i.e. can receive the taps. */
  readonly canAsk: () => boolean
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/**
 * The `propose_memory` tool (F12): shows the lines with Approve and Reject
 * buttons and returns at once; the answer reaches the session later as a
 * channel message. What is approved is exactly what was shown: a proposal
 * whose text redaction would change, or that does not fit one message, is
 * refused and never stored as pending. Audit rows carry ids and counts,
 * never the lines.
 */
export class ProposeMemory {
  constructor(private readonly deps: ProposeMemoryDeps) {}

  async execute(request: ProposeMemoryRequest): Promise<ProposeMemoryOutcome> {
    const { store, logger } = this.deps
    if (!this.deps.target.execute(request.chatId)) {
      this.#refused(request, 'chat_not_allowed')
      return { status: 'refused', reason: 'chat_not_allowed' }
    }
    if (!this.deps.canAsk()) {
      logger.warn('propose_memory refused: this process does not poll telegram')
      return { status: 'refused', reason: 'not_polling' }
    }
    const checked = checkMemoryLines(request.lines)
    if (!checked.ok) {
      this.#refused(request, checked.problem)
      return {
        status: 'invalid',
        problem: checked.problem,
        ...(checked.line === undefined ? {} : { line: checked.line }),
      }
    }
    const proposal = MemoryProposal.open({
      id: memoryProposalIdFrom(this.deps.random.bytes(10)),
      session: this.deps.session,
      chatId: request.chatId,
      lines: checked.lines,
      now: this.deps.clock.now(),
    })
    store.put(proposal)
    let ref: PromptRef
    try {
      ref = await this.deps.prompts.send(proposal)
    } catch (error) {
      store.update(proposal.cancel(this.deps.clock.now()), proposal.revision)
      if (error instanceof PromptRedactedError || error instanceof PromptTooLongError) {
        const problem =
          error instanceof PromptRedactedError ? 'contains_secret' : 'too_long_for_one_message'
        this.#refused(request, problem)
        return { status: 'invalid', problem }
      }
      logger.error('could not show a memory proposal', { proposalId: proposal.id, error })
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    this.#attachPrompt(proposal, ref)
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: 'session',
      event: 'memory.proposed',
      details: {
        proposalId: proposal.id,
        chatId: request.chatId,
        lines: proposal.lineCount,
        characters: proposal.lines.reduce((total, line) => total + [...line].length, 0),
      },
    })
    logger.info('proposed memory lines', { proposalId: proposal.id, lines: proposal.lineCount })
    return { status: 'proposed', proposalId: proposal.id }
  }

  /** Stores where the buttons are, retrying if a tap changed the proposal in between. */
  #attachPrompt(proposal: MemoryProposal, ref: PromptRef): void {
    let current: MemoryProposal | undefined = proposal
    while (current !== undefined) {
      if (this.deps.store.update(current.withPrompt(ref), current.revision)) return
      current = this.deps.store.findById(proposal.id)
    }
  }

  #refused(request: ProposeMemoryRequest, reason: string): void {
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: 'session',
      event: 'memory.refused',
      details: { chatId: auditableChatId(request.chatId), reason, lines: request.lines.length },
    })
    this.deps.logger.warn('propose_memory refused', { reason })
  }
}
