import { choiceIdFrom, isChoiceId } from '../choices/Choice.ts'
import { DomainError } from '../DomainError.ts'
import type { PromptRef } from '../permissions/PermissionRequest.ts'
import type { SenderId } from '../Sender.ts'
import { VOICE_TRANSCRIPT_TTL_MS } from './voiceNote.ts'

/** Same shape as choice ids: ten base32 characters, 50 random bits. */
export const isVoiceTranscriptId = isChoiceId
export const voiceTranscriptIdFrom = choiceIdFrom

/**
 * pending -> sent (Send tapped: the text entered the inbound chain)
 * | discarded (Discard tapped) | expired (TTL) | cancelled (its session is
 * gone, or the prompt could not be shown). Every closed state is final.
 */
export type VoiceTranscriptState = 'pending' | 'sent' | 'discarded' | 'expired' | 'cancelled'

export interface VoiceTranscriptSnapshot {
  readonly id: string
  /** The channel process that showed it; only it can resolve it. */
  readonly session: string
  readonly chatId: string
  /** The cleaned transcript exactly as shown; kept only while pending. */
  readonly text: string
  /** Code points in the text; kept after the text is dropped. */
  readonly length: number
  /** The note's declared duration, whole seconds. */
  readonly durationSeconds: number
  readonly state: VoiceTranscriptState
  readonly createdAt: number
  readonly resolvedBy: SenderId | undefined
  readonly closedAt: number | undefined
  readonly prompt: PromptRef | undefined
  readonly revision: number
}

export class InvalidVoiceTranscriptTransitionError extends DomainError {
  constructor(
    readonly from: VoiceTranscriptState,
    readonly action: string,
  ) {
    super(`Cannot ${action} a voice transcript that is ${from}`)
  }
}

export interface OpenVoiceTranscriptInput {
  readonly id: string
  readonly session: string
  readonly chatId: string
  /** Already cleaned (`cleanTranscript`), non-empty and within the length cap. */
  readonly text: string
  readonly durationSeconds: number
  readonly now: number
}

/**
 * A voice note's transcript waiting for the owner (F13). Nothing reaches the
 * session unless the owner taps Send on the message that shows the whole
 * text, so a transcription mistake never becomes an instruction on its own.
 * Immutable; every transition bumps the revision for compare-and-set.
 */
export class VoiceTranscript {
  readonly #data: VoiceTranscriptSnapshot

  private constructor(data: VoiceTranscriptSnapshot) {
    this.#data = data
  }

  static open(input: OpenVoiceTranscriptInput): VoiceTranscript {
    if (!isVoiceTranscriptId(input.id)) throw new DomainError('Invalid voice transcript id')
    if (input.text.trim() === '') throw new DomainError('A voice transcript cannot be empty')
    return new VoiceTranscript({
      id: input.id,
      session: input.session,
      chatId: input.chatId,
      text: input.text,
      length: [...input.text].length,
      durationSeconds: Math.max(0, Math.round(input.durationSeconds)),
      state: 'pending',
      createdAt: input.now,
      resolvedBy: undefined,
      closedAt: undefined,
      prompt: undefined,
      revision: 0,
    })
  }

  static restore(snapshot: VoiceTranscriptSnapshot): VoiceTranscript {
    return new VoiceTranscript(snapshot)
  }

  toSnapshot(): VoiceTranscriptSnapshot {
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

  get text(): string {
    return this.#data.text
  }

  get length(): number {
    return this.#data.length
  }

  get durationSeconds(): number {
    return this.#data.durationSeconds
  }

  get state(): VoiceTranscriptState {
    return this.#data.state
  }

  get createdAt(): number {
    return this.#data.createdAt
  }

  get resolvedBy(): SenderId | undefined {
    return this.#data.resolvedBy
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

  get isPending(): boolean {
    return this.state === 'pending'
  }

  isDue(now: number): boolean {
    return this.isPending && now >= this.#data.createdAt + VOICE_TRANSCRIPT_TTL_MS
  }

  send(by: SenderId, now: number): VoiceTranscript {
    if (!this.isPending) this.#invalid('send')
    return this.#apply({ state: 'sent', resolvedBy: by, closedAt: now })
  }

  discard(by: SenderId, now: number): VoiceTranscript {
    if (!this.isPending) this.#invalid('discard')
    return this.#apply({ state: 'discarded', resolvedBy: by, closedAt: now })
  }

  expire(now: number): VoiceTranscript {
    if (!this.isPending) this.#invalid('expire')
    return this.#apply({ state: 'expired', closedAt: now })
  }

  cancel(now: number): VoiceTranscript {
    if (!this.isPending) this.#invalid('cancel')
    return this.#apply({ state: 'cancelled', closedAt: now })
  }

  /** Remembers where the buttons were posted. Not a state transition. */
  withPrompt(prompt: PromptRef): VoiceTranscript {
    return this.#apply({ prompt })
  }

  #invalid(action: string): never {
    throw new InvalidVoiceTranscriptTransitionError(this.state, action)
  }

  #apply(changes: Partial<VoiceTranscriptSnapshot>): VoiceTranscript {
    return new VoiceTranscript({ ...this.#data, ...changes, revision: this.#data.revision + 1 })
  }
}
