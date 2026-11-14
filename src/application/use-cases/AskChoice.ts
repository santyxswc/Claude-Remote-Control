import {
  Choice,
  type ChoiceProblem,
  choiceIdFrom,
  normalizeChoiceOptions,
  normalizeChoiceQuestion,
} from '../../domain/choices/Choice.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { ChoicePrompts } from '../choices/ChoicePrompts.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { ChoiceStore } from '../ports/ChoiceStore.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { RandomSource } from '../ports/RandomSource.ts'
import { type AuthorizeReplyTarget, auditableChatId } from './AuthorizeReplyTarget.ts'

/** What Claude passed to `ask_choice`. Every field is untrusted. */
export interface AskChoiceRequest {
  readonly chatId: string
  readonly question: string
  readonly options: readonly string[]
  readonly allowOther: boolean
}

export type AskChoiceOutcome =
  | { readonly status: 'asked'; readonly choiceId: string }
  | { readonly status: 'refused'; readonly reason: 'chat_not_allowed' | 'not_polling' }
  | { readonly status: 'invalid'; readonly problem: ChoiceProblem }
  | { readonly status: 'failed'; readonly error: string }

export interface AskChoiceDeps {
  readonly store: ChoiceStore
  readonly prompts: ChoicePrompts
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
 * The `ask_choice` tool (F7): posts the question with one button per option
 * and returns at once; the answer comes back later as a channel event. The
 * question and labels are Claude's text, shown sanitized and redacted. Audit
 * rows carry ids and counts, never the question or the labels.
 */
export class AskChoice {
  constructor(private readonly deps: AskChoiceDeps) {}

  async execute(request: AskChoiceRequest): Promise<AskChoiceOutcome> {
    const { store, logger } = this.deps
    if (!this.deps.target.execute(request.chatId)) {
      this.#audit('choice.refused', {
        chatId: auditableChatId(request.chatId),
        reason: 'chat_not_allowed',
      })
      logger.warn('ask_choice refused', { reason: 'chat_not_allowed' })
      return { status: 'refused', reason: 'chat_not_allowed' }
    }
    if (!this.deps.canAsk()) {
      logger.warn('ask_choice refused: this process does not poll telegram')
      return { status: 'refused', reason: 'not_polling' }
    }
    const question = normalizeChoiceQuestion(request.question)
    if (!question.ok) return { status: 'invalid', problem: question.problem }
    const options = normalizeChoiceOptions(request.options)
    if (!options.ok) return { status: 'invalid', problem: options.problem }

    const now = this.deps.clock.now()
    const choice = Choice.open({
      id: choiceIdFrom(this.deps.random.bytes(10)),
      session: this.deps.session,
      chatId: request.chatId,
      question: question.value,
      options: options.value,
      allowOther: request.allowOther,
      now,
    })
    store.put(choice)
    let ref: PromptRef
    try {
      ref = await this.deps.prompts.send(choice)
    } catch (error) {
      const failed = choice.cancel(this.deps.clock.now())
      store.update(failed, choice.revision)
      logger.error('could not send a choice', { choiceId: choice.id, error })
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    this.#attachPrompt(choice, ref)
    this.#audit('choice.asked', {
      choiceId: choice.id,
      chatId: request.chatId,
      options: choice.options.length,
      allowOther: choice.allowOther,
    })
    logger.info('asked a choice', { choiceId: choice.id })
    return { status: 'asked', choiceId: choice.id }
  }

  /** Stores where the buttons are, retrying if a tap changed the choice in between. */
  #attachPrompt(choice: Choice, ref: PromptRef): void {
    let current: Choice | undefined = choice
    while (current !== undefined) {
      if (this.deps.store.update(current.withPrompt(ref), current.revision)) return
      current = this.deps.store.findById(choice.id)
    }
  }

  #audit(
    event: 'choice.asked' | 'choice.refused',
    details: Record<string, string | number | boolean>,
  ): void {
    this.deps.audit.append({ at: this.deps.clock.now(), actor: 'session', event, details })
  }
}
