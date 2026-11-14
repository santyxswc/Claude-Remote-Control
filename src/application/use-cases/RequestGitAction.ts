import type { SenderProfile } from '../../domain/Sender.ts'
import { revertConfirmKeyboard } from '../git/diffPresentation.ts'
import type { GitButton } from '../git/gitCallbackData.ts'
import type { GitAction, GitTapOutcome, Messages } from '../i18n/messages.ts'
import type { InboundHandler } from '../pipeline/InboundStep.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PromptGateway } from '../ports/PromptGateway.ts'

/** Commit, Revert and Open PR buttons work this long after `/diff`. */
export const GIT_BUTTON_TTL_MS = 30 * 60_000
/** Confirm revert must be tapped this soon after Revert. */
export const GIT_CONFIRM_TTL_MS = 2 * 60_000
/** A stamp this far in the future (a skewed clock at most) is still accepted. */
const CLOCK_SKEW_MS = 60_000

export interface GitTapInput {
  readonly button: GitButton
  readonly issuedAt: number
  readonly sender: SenderProfile
  readonly chatId: string
  readonly messageId: string | undefined
}

const ACTION_OF: Readonly<Partial<Record<GitButton, GitAction>>> = {
  commit: 'commit',
  pr: 'pr',
  confirm_revert: 'revert',
}

/**
 * A tap on a `/diff` button (F8). Commit and Open PR, and Revert once
 * confirmed, feed one fixed instruction from the catalog into the inbound
 * chain as text from the owner, exactly like typing it: the rate limit, the
 * brake gate and the audit apply, and the session asks permission for every
 * tool call it then makes. Nothing from the repository goes into the
 * instruction. A tap can never approve anything: only `p1:` buttons reach
 * `ResolvePermission`. The first Revert tap only swaps the buttons for
 * Confirm revert / Cancel.
 */
export class RequestGitAction {
  constructor(
    private readonly deps: {
      /** The inbound chain (after the tap path's own authentication). */
      readonly deliver: InboundHandler
      readonly prompts: Pick<PromptGateway, 'editPrompt'>
      readonly brake: Pick<BrakeFlag, 'status'>
      readonly messages: Pick<
        Messages,
        | 'gitActionButtons'
        | 'gitRevertConfirm'
        | 'gitRevertCancelled'
        | 'gitActionSent'
        | 'gitInstruction'
      >
      readonly audit: AuditLog
      readonly clock: Clock
      readonly logger: Logger
    },
  ) {}

  async execute(input: GitTapInput): Promise<GitTapOutcome> {
    const now = this.deps.clock.now()
    const ttl =
      input.button === 'confirm_revert' || input.button === 'cancel_revert'
        ? GIT_CONFIRM_TTL_MS
        : GIT_BUTTON_TTL_MS
    if (now - input.issuedAt > ttl || input.issuedAt - now > CLOCK_SKEW_MS) return 'expired'
    // Checked here for the toast; the chain's brake gate refuses the instruction again anyway.
    if (this.deps.brake.status().engaged) return 'braked'
    const { messages } = this.deps

    if (input.button === 'revert') {
      await this.#edit(input, messages.gitRevertConfirm, revertConfirmKeyboard(messages, now))
      return 'confirm'
    }
    if (input.button === 'cancel_revert') {
      await this.#edit(input, messages.gitRevertCancelled, [])
      return 'cancelled'
    }
    const action = ACTION_OF[input.button]
    if (action === undefined) return 'expired'
    await this.deps.deliver({
      chatId: input.chatId,
      messageId: input.messageId ?? '0',
      chatKind: 'private',
      sender: input.sender,
      text: messages.gitInstruction(action),
      sentAt: now,
    })
    this.deps.audit.append({
      at: now,
      actor: `telegram:${input.sender.id}`,
      event: 'git.action_requested',
      details: { action },
    })
    await this.#edit(input, messages.gitActionSent(action), [])
    return 'sent'
  }

  async #edit(
    input: GitTapInput,
    text: string,
    keyboard: Parameters<PromptGateway['editPrompt']>[2],
  ): Promise<void> {
    if (input.messageId === undefined) return
    try {
      await this.deps.prompts.editPrompt(
        { chatId: input.chatId, messageId: input.messageId },
        text,
        keyboard,
      )
    } catch (error) {
      this.deps.logger.warn('could not update the /diff buttons', { error })
    }
  }
}
