import type { Choice } from '../../domain/choices/Choice.ts'
import { senderLabel } from '../../domain/displayText.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { ChoicePrompts } from '../choices/ChoicePrompts.ts'
import type { ChoicePick } from '../choices/choiceCallbackData.ts'
import type { ChoiceOutcome } from '../i18n/messages.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { ChoiceStore } from '../ports/ChoiceStore.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { AuthorizeSender } from './AuthorizeSender.ts'
import type { HandleInboundMessage } from './HandleInboundMessage.ts'

export interface AnswerChoiceInput {
  readonly choiceId: string
  readonly pick: ChoicePick
  /** Who tapped; checked against the allowlist again here. */
  readonly sender: SenderProfile
  /** The tapped message's chat and id; the chat must be the one the choice was asked in. */
  readonly chatId: string
  readonly messageId: string | undefined
}

export interface AnswerChoiceDeps {
  readonly store: ChoiceStore
  readonly prompts: ChoicePrompts
  /** The same delivery as typed text: typing status, "queued" note, audit. */
  readonly forward: Pick<HandleInboundMessage, 'execute'>
  readonly authorize: AuthorizeSender
  readonly brake: Pick<BrakeFlag, 'status'>
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/**
 * A tap on a choice button (F7). The chosen label goes to the session as a
 * normal message from the owner: it is text, never a permission verdict,
 * and nothing is sent while the brake is engaged. The answer is stored with
 * compare-and-set before it is delivered, so a double tap or a racing expiry
 * delivers once; if delivery fails the choice is open again.
 */
export class AnswerChoice {
  constructor(private readonly deps: AnswerChoiceDeps) {}

  async execute(input: AnswerChoiceInput): Promise<ChoiceOutcome> {
    const { store, logger } = this.deps
    const { sender } = input
    if (!this.deps.authorize.execute(sender.id)) {
      logger.warn('choice answer from a sender who is not allowed', { senderId: sender.id })
      return 'not_allowed'
    }
    const stored = store.findById(input.choiceId)
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
        await this.deps.prompts.refresh(expired, { status: 'expired' }, ref)
      }
      return 'expired'
    }
    const closed = closedOutcome(stored)
    if (closed !== undefined) return closed
    if (this.deps.brake.status().engaged) return 'braked'

    if (input.pick === 'other') {
      if (!stored.allowOther) return 'not_found'
      const next = stored.chooseOther()
      if (!store.update(next, stored.revision)) return this.#raced(stored.id)
      await this.deps.prompts.refresh(next, { status: 'awaiting_text' }, ref)
      return 'awaiting_text'
    }
    const label = stored.options[input.pick]
    if (label === undefined) return 'not_found'
    const next = stored.choose(input.pick, sender.id, now)
    if (!store.update(next, stored.revision)) return this.#raced(stored.id)

    const outcome = await this.deps.forward.execute({
      chatId: input.chatId,
      messageId: ref?.messageId ?? '0',
      chatKind: 'private',
      sender,
      text: label,
      sentAt: now,
      forwardContext: { kind: 'choice', choiceId: stored.id },
    })
    if (outcome !== 'forwarded') {
      store.update(next.deliveryFailed(), next.revision)
      return 'delivery_failed'
    }
    this.deps.audit.append({
      at: now,
      actor: `telegram:${sender.id}`,
      event: 'choice.answered',
      details: { choiceId: stored.id, via: 'button', option: input.pick },
    })
    await this.deps.prompts.refresh(
      next,
      { status: 'answered', label, who: senderLabel(sender), at: new Date(now).toISOString() },
      ref,
    )
    return 'answered'
  }

  /** Someone else changed it first; describe what it is now, and send nothing. */
  #raced(choiceId: string): ChoiceOutcome {
    const latest = this.deps.store.findById(choiceId)
    return latest === undefined ? 'not_found' : (closedOutcome(latest) ?? 'already_answered')
  }
}

function closedOutcome(choice: Choice): ChoiceOutcome | undefined {
  switch (choice.state) {
    case 'pending':
      return undefined
    case 'awaiting_text':
    case 'answered':
      return 'already_answered'
    case 'expired':
      return 'expired'
    case 'cancelled':
      return 'not_found'
  }
}
