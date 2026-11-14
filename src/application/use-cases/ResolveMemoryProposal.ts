import { senderLabel } from '../../domain/displayText.ts'
import type { MemoryProposal } from '../../domain/memory/MemoryProposal.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import { ProjectFileError } from '../errors.ts'
import type { MemoryNotice, MemoryTapOutcome, Messages } from '../i18n/messages.ts'
import type { MemoryPrompts } from '../memory/MemoryPrompts.ts'
import type { MemoryAction } from '../memory/memoryCallbackData.ts'
import type { AuditEvent, AuditLog } from '../ports/AuditLog.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { MemoryProposalStore } from '../ports/MemoryProposalStore.ts'
import type { ProjectMemoryFile } from '../ports/ProjectMemoryFile.ts'
import type { AuthorizeSender } from './AuthorizeSender.ts'
import type { HandleInboundMessage } from './HandleInboundMessage.ts'

/** The file approved lines go to, as the session and the chat name it. */
export const MEMORY_FILE_NAME = 'CLAUDE.md'

export interface ResolveMemoryInput {
  readonly proposalId: string
  readonly action: MemoryAction
  /** Who tapped; checked against the allowlist again here. */
  readonly sender: SenderProfile
  /** The tapped message's chat and id; the chat must be the one the proposal was shown in. */
  readonly chatId: string
  readonly messageId: string | undefined
}

export interface ResolveMemoryDeps {
  readonly store: MemoryProposalStore
  readonly prompts: MemoryPrompts
  readonly file: ProjectMemoryFile
  /** The same delivery as typed text, for telling the session the outcome. */
  readonly forward: Pick<HandleInboundMessage, 'execute'>
  readonly authorize: AuthorizeSender
  readonly brake: Pick<BrakeFlag, 'status'>
  readonly messages: Pick<Messages, 'memorySessionOutcome'>
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/**
 * A tap on Approve or Reject under a memory proposal (F12). One tap is
 * enough: every line was shown in full. Approve claims the proposal with
 * compare-and-set, then the bridge itself appends the lines to `CLAUDE.md`
 * (a failed write reopens it); Reject writes nothing. Either way the session
 * is told afterwards as a channel message, except while the brake is
 * engaged: the write is the owner's own act and still happens, but nothing
 * is sent to Claude. A second tap only gets a toast.
 */
export class ResolveMemoryProposal {
  constructor(private readonly deps: ResolveMemoryDeps) {}

  async execute(input: ResolveMemoryInput): Promise<MemoryTapOutcome> {
    const { store, logger } = this.deps
    const { sender } = input
    if (!this.deps.authorize.execute(sender.id)) {
      logger.warn('memory tap from a sender who is not allowed', { senderId: sender.id })
      return 'not_allowed'
    }
    const stored = store.findById(input.proposalId)
    if (
      stored === undefined ||
      stored.session !== this.deps.session ||
      stored.chatId !== input.chatId
    ) {
      return 'not_found'
    }
    const ref: PromptRef | undefined =
      stored.prompt ??
      (input.messageId === undefined
        ? undefined
        : { chatId: input.chatId, messageId: input.messageId })
    const now = this.deps.clock.now()
    if (stored.isDue(now)) {
      const expired = stored.expire(now)
      if (store.update(expired, stored.revision)) {
        this.#audit('memory.expired', sender, { proposalId: stored.id, reason: 'ttl' })
        await this.deps.prompts.refresh(expired, { status: 'expired' }, ref)
      }
      return 'expired'
    }
    const closed = closedOutcome(stored)
    if (closed !== undefined) return closed
    return input.action === 'approve'
      ? this.#approve(stored, sender, now, ref)
      : this.#reject(stored, sender, now, ref)
  }

  async #approve(
    stored: MemoryProposal,
    sender: SenderProfile,
    now: number,
    ref: PromptRef | undefined,
  ): Promise<MemoryTapOutcome> {
    const { store, logger } = this.deps
    const next = stored.approve(sender.id, now)
    if (!store.update(next, stored.revision)) return this.#raced(stored.id)
    let file: string
    try {
      file = (await this.deps.file.append(stored.lines)).relativePath
    } catch (error) {
      store.update(next.writeFailed(), next.revision)
      const problem = error instanceof ProjectFileError ? error.problem : 'io'
      this.#audit('memory.write_failed', sender, { proposalId: stored.id, reason: problem })
      logger.error('could not append memory lines', { proposalId: stored.id, problem, error })
      return 'write_failed'
    }
    this.#audit('memory.approved', sender, { proposalId: stored.id, lines: stored.lineCount })
    logger.info('memory lines approved', { proposalId: stored.id, lines: stored.lineCount })
    const notice = await this.#tell(stored, sender, now, 'approved', file)
    await this.deps.prompts.refresh(
      next,
      {
        status: 'approved',
        who: senderLabel(sender),
        at: new Date(now).toISOString(),
        file,
        notice,
      },
      ref,
    )
    return notice === 'braked' ? 'approved_braked' : 'approved'
  }

  async #reject(
    stored: MemoryProposal,
    sender: SenderProfile,
    now: number,
    ref: PromptRef | undefined,
  ): Promise<MemoryTapOutcome> {
    const next = stored.reject(sender.id, now)
    if (!this.deps.store.update(next, stored.revision)) return this.#raced(stored.id)
    this.#audit('memory.rejected', sender, { proposalId: stored.id, lines: stored.lineCount })
    const notice = await this.#tell(stored, sender, now, 'rejected', MEMORY_FILE_NAME)
    await this.deps.prompts.refresh(
      next,
      { status: 'rejected', who: senderLabel(sender), at: new Date(now).toISOString(), notice },
      ref,
    )
    return notice === 'braked' ? 'rejected_braked' : 'rejected'
  }

  /** The outcome as a channel message; nothing while braked. */
  async #tell(
    proposal: MemoryProposal,
    sender: SenderProfile,
    now: number,
    outcome: 'approved' | 'rejected',
    file: string,
  ): Promise<MemoryNotice> {
    if (this.deps.brake.status().engaged) return 'braked'
    const delivered = await this.deps.forward.execute({
      chatId: proposal.chatId,
      messageId: proposal.prompt?.messageId ?? '0',
      chatKind: 'private',
      sender,
      text: this.deps.messages.memorySessionOutcome({
        outcome,
        proposalId: proposal.id,
        lines: proposal.lineCount,
        file,
      }),
      sentAt: now,
      forwardContext: { kind: 'memory', proposalId: proposal.id },
    })
    return delivered === 'forwarded' ? 'told' : 'not_delivered'
  }

  /** Someone else changed it first; describe what it is now. */
  #raced(proposalId: string): MemoryTapOutcome {
    const latest = this.deps.store.findById(proposalId)
    return latest === undefined ? 'not_found' : (closedOutcome(latest) ?? 'already_resolved')
  }

  #audit(event: AuditEvent, sender: SenderProfile, details: Record<string, string | number>): void {
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: `telegram:${sender.id}`,
      event,
      details,
    })
  }
}

function closedOutcome(proposal: MemoryProposal): MemoryTapOutcome | undefined {
  switch (proposal.state) {
    case 'pending':
      return undefined
    case 'approved':
    case 'rejected':
      return 'already_resolved'
    case 'expired':
      return 'expired'
    case 'cancelled':
      return 'not_found'
  }
}
