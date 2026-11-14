import { senderLabel } from '../../domain/displayText.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { ChoicePrompts } from '../choices/ChoicePrompts.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { ChoiceStore } from '../ports/ChoiceStore.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'

export interface AnswerChoiceWithTextDeps {
  readonly store: ChoiceStore
  readonly prompts: ChoicePrompts
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/**
 * After "Other..." (F7): the next text message of that chat answers the
 * choice. This only closes the choice and says which one it was; the message
 * itself is delivered like any other (the caller passes it on).
 */
export class AnswerChoiceWithText {
  constructor(private readonly deps: AnswerChoiceWithTextDeps) {}

  /** The id of the choice the message answers, or undefined when none waits for text. */
  async execute(input: {
    readonly chatId: string
    readonly sender: SenderProfile
  }): Promise<string | undefined> {
    const { store, clock } = this.deps
    const now = clock.now()
    // Newest first: the "Other..." tapped last is the one being answered.
    const waiting = [...store.listOpen()]
      .reverse()
      .find(
        (choice) =>
          choice.session === this.deps.session &&
          choice.chatId === input.chatId &&
          choice.state === 'awaiting_text' &&
          !choice.isDue(now),
      )
    if (waiting === undefined) return undefined
    const answered = waiting.answerWithText(input.sender.id, now)
    if (!store.update(answered, waiting.revision)) return undefined
    this.deps.audit.append({
      at: now,
      actor: `telegram:${input.sender.id}`,
      event: 'choice.answered',
      details: { choiceId: waiting.id, via: 'text' },
    })
    await this.deps.prompts.refresh(answered, {
      status: 'answered_with_text',
      who: senderLabel(input.sender),
      at: new Date(now).toISOString(),
    })
    return waiting.id
  }
}
