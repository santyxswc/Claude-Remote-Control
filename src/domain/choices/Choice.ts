import { DomainError } from '../DomainError.ts'
import { sanitizeDisplayText, sanitizeMultilineText } from '../displayText.ts'
import type { PromptRef } from '../permissions/PermissionRequest.ts'
import type { SenderId } from '../Sender.ts'

/** An unanswered choice expires after this long. */
export const CHOICE_TTL_MS = 30 * 60_000

export const MIN_CHOICE_OPTIONS = 2
export const MAX_CHOICE_OPTIONS = 8
/** Longest option label, in code points, after sanitizing. */
export const MAX_CHOICE_LABEL_LENGTH = 64

/** Ten characters of RFC 4648 base32 (lowercase): 50 random bits. */
const CHOICE_ID = /^[a-z2-7]{10}$/
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function isChoiceId(value: string): boolean {
  return CHOICE_ID.test(value)
}

/** A choice id from 10 random bytes (5 bits each, no modulo bias). */
export function choiceIdFrom(bytes: Uint8Array): string {
  if (bytes.length < 10) throw new DomainError('A choice id needs 10 random bytes')
  return [...bytes.subarray(0, 10)].map((byte) => BASE32[byte & 31]).join('')
}

/**
 * pending -> answered (an option tapped) | awaiting_text ("Other..." tapped)
 * | expired (TTL) | cancelled (its session is gone). awaiting_text ->
 * answered (the next text from the chat) | expired | cancelled. An answer
 * that could not be delivered goes back to pending.
 */
export type ChoiceState = 'pending' | 'awaiting_text' | 'answered' | 'expired' | 'cancelled'

export type ChoiceAnswer =
  | { readonly kind: 'option'; readonly index: number }
  | { readonly kind: 'text' }

export interface ChoiceSnapshot {
  readonly id: string
  /** The channel process that asked; only it can deliver the answer. */
  readonly session: string
  readonly chatId: string
  /** Sanitized; may span lines. */
  readonly question: string
  /** Sanitized one-line labels. */
  readonly options: readonly string[]
  readonly allowOther: boolean
  readonly state: ChoiceState
  readonly createdAt: number
  readonly answer: ChoiceAnswer | undefined
  readonly answeredBy: SenderId | undefined
  /** When it was closed, by an answer, expiry or cancellation. */
  readonly closedAt: number | undefined
  readonly prompt: PromptRef | undefined
  readonly revision: number
}

export class InvalidChoiceTransitionError extends DomainError {
  constructor(
    readonly from: ChoiceState,
    readonly action: string,
  ) {
    super(`Cannot ${action} a choice that is ${from}`)
  }
}

export type ChoiceProblem =
  | 'empty_question'
  | 'too_few_options'
  | 'too_many_options'
  | 'empty_option'
  | 'option_too_long'
  | 'duplicate_option'

export type Normalized<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: ChoiceProblem }

/** The question as it will be shown: plain text, no controls or bidi tricks. */
export function normalizeChoiceQuestion(raw: string): Normalized<string> {
  const question = sanitizeMultilineText(raw)
  return question === '' ? { ok: false, problem: 'empty_question' } : { ok: true, value: question }
}

/**
 * Labels as they will be shown on the buttons: one line each, sanitized,
 * non-empty, at most 64 code points (never cut: a cut label could be
 * mistaken for another), unique ignoring case.
 */
export function normalizeChoiceOptions(raw: readonly string[]): Normalized<readonly string[]> {
  if (raw.length < MIN_CHOICE_OPTIONS) return { ok: false, problem: 'too_few_options' }
  if (raw.length > MAX_CHOICE_OPTIONS) return { ok: false, problem: 'too_many_options' }
  const options = raw.map((label) => sanitizeDisplayText(label, Number.POSITIVE_INFINITY))
  if (options.some((label) => label === '')) return { ok: false, problem: 'empty_option' }
  if (options.some((label) => [...label].length > MAX_CHOICE_LABEL_LENGTH)) {
    return { ok: false, problem: 'option_too_long' }
  }
  const seen = new Set(options.map((label) => label.toLowerCase()))
  if (seen.size !== options.length) return { ok: false, problem: 'duplicate_option' }
  return { ok: true, value: options }
}

export interface OpenChoiceInput {
  readonly id: string
  readonly session: string
  readonly chatId: string
  /** Already normalized (`normalizeChoiceQuestion`, `normalizeChoiceOptions`). */
  readonly question: string
  readonly options: readonly string[]
  readonly allowOther: boolean
  readonly now: number
}

/**
 * A multiple-choice question Claude asked the owner. Answering it only ever
 * produces text for the session: it is never a permission verdict.
 * Immutable: every transition returns a new instance with the revision
 * incremented (stores use it for compare-and-set).
 */
export class Choice {
  readonly #data: ChoiceSnapshot

  private constructor(data: ChoiceSnapshot) {
    this.#data = data
  }

  static open(input: OpenChoiceInput): Choice {
    if (!isChoiceId(input.id)) throw new DomainError('Invalid choice id')
    return new Choice({
      id: input.id,
      session: input.session,
      chatId: input.chatId,
      question: input.question,
      options: [...input.options],
      allowOther: input.allowOther,
      state: 'pending',
      createdAt: input.now,
      answer: undefined,
      answeredBy: undefined,
      closedAt: undefined,
      prompt: undefined,
      revision: 0,
    })
  }

  static restore(snapshot: ChoiceSnapshot): Choice {
    return new Choice(snapshot)
  }

  toSnapshot(): ChoiceSnapshot {
    return this.#data
  }

  get id(): string {
    return this.#data.id
  }

  get session(): string {
    return this.#data.session
  }

  get chatId(): string {
    return this.#data.chatId
  }

  get question(): string {
    return this.#data.question
  }

  get options(): readonly string[] {
    return this.#data.options
  }

  get allowOther(): boolean {
    return this.#data.allowOther
  }

  get state(): ChoiceState {
    return this.#data.state
  }

  get createdAt(): number {
    return this.#data.createdAt
  }

  get answer(): ChoiceAnswer | undefined {
    return this.#data.answer
  }

  get answeredBy(): SenderId | undefined {
    return this.#data.answeredBy
  }

  get closedAt(): number | undefined {
    return this.#data.closedAt
  }

  get prompt(): PromptRef | undefined {
    return this.#data.prompt
  }

  get revision(): number {
    return this.#data.revision
  }

  /** Pending or awaiting a typed answer. */
  get isOpen(): boolean {
    return this.state === 'pending' || this.state === 'awaiting_text'
  }

  isDue(now: number): boolean {
    return this.isOpen && now >= this.#data.createdAt + CHOICE_TTL_MS
  }

  /** The label of the chosen option, if an option was chosen. */
  get chosenLabel(): string | undefined {
    const answer = this.#data.answer
    return answer?.kind === 'option' ? this.#data.options[answer.index] : undefined
  }

  choose(index: number, by: SenderId, now: number): Choice {
    if (this.state !== 'pending') this.#invalid('choose an option of')
    if (!Number.isInteger(index) || index < 0 || index >= this.options.length) {
      this.#invalid('choose a missing option of')
    }
    return this.#apply({
      state: 'answered',
      answer: { kind: 'option', index },
      answeredBy: by,
      closedAt: now,
    })
  }

  /** "Other...": the next text from the chat is the answer. */
  chooseOther(): Choice {
    if (this.state !== 'pending' || !this.allowOther) this.#invalid('choose "other" for')
    return this.#apply({ state: 'awaiting_text' })
  }

  answerWithText(by: SenderId, now: number): Choice {
    if (this.state !== 'awaiting_text') this.#invalid('answer with text')
    return this.#apply({
      state: 'answered',
      answer: { kind: 'text' },
      answeredBy: by,
      closedAt: now,
    })
  }

  /** The answer could not be handed to the session: nothing was answered. */
  deliveryFailed(): Choice {
    if (this.state !== 'answered') this.#invalid('record a failed delivery for')
    return this.#apply({
      state: 'pending',
      answer: undefined,
      answeredBy: undefined,
      closedAt: undefined,
    })
  }

  expire(now: number): Choice {
    if (!this.isOpen) this.#invalid('expire')
    return this.#apply({ state: 'expired', closedAt: now })
  }

  /** Its session is gone: the answer could no longer reach it. */
  cancel(now: number): Choice {
    if (!this.isOpen) this.#invalid('cancel')
    return this.#apply({ state: 'cancelled', closedAt: now })
  }

  /** Remembers where the buttons were posted. Not a state transition. */
  withPrompt(prompt: PromptRef): Choice {
    return this.#apply({ prompt })
  }

  #invalid(action: string): never {
    throw new InvalidChoiceTransitionError(this.state, action)
  }

  #apply(changes: Partial<ChoiceSnapshot>): Choice {
    return new Choice({ ...this.#data, ...changes, revision: this.#data.revision + 1 })
  }
}
