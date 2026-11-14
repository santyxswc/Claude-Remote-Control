import { choiceIdFrom, isChoiceId } from '../choices/Choice.ts'
import { DomainError } from '../DomainError.ts'
import type { PromptRef } from '../permissions/PermissionRequest.ts'
import type { SenderId } from '../Sender.ts'

/** An unanswered proposal expires after this long. */
export const MEMORY_PROPOSAL_TTL_MS = 30 * 60_000
export const MAX_MEMORY_LINES = 8
/** Longest line, in code points. */
export const MAX_MEMORY_LINE_LENGTH = 300

/** Same shape as choice ids: ten base32 characters, 50 random bits. */
export const isMemoryProposalId = isChoiceId
export const memoryProposalIdFrom = choiceIdFrom

export type MemoryLineProblem =
  | 'no_lines'
  | 'too_many_lines'
  | 'empty_line'
  | 'line_too_long'
  | 'control_characters'
  | 'invisible_characters'
  | 'code_fence'
  | 'html_comment'

/** Line breaks (any kind), C0/C1 controls (tab included) and DEL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u
/** Bidi controls, directional marks, zero-width and invisible format characters, soft hyphen. */
const INVISIBLE =
  /[\u{ad}\u{61c}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{206f}\u{feff}]/u

export type MemoryLinesCheck =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly problem: MemoryLineProblem; readonly line?: number }

/**
 * The lines exactly as they will be shown and, if approved, written: 1 to 8,
 * each trimmed, non-empty, one line of at most 300 code points. Nothing is
 * cleaned silently: anything the chat would not show as typed (a control or
 * invisible character) refuses the proposal. Markdown is kept as plain text,
 * except fence markers and HTML comments, which would change or hide what
 * follows them when `CLAUDE.md` is rendered (on GitHub, say).
 */
export function checkMemoryLines(raw: readonly string[]): MemoryLinesCheck {
  if (raw.length === 0) return { ok: false, problem: 'no_lines' }
  if (raw.length > MAX_MEMORY_LINES) return { ok: false, problem: 'too_many_lines' }
  const lines: string[] = []
  for (const [index, original] of raw.entries()) {
    const line = original.trim()
    const problem = lineProblem(line)
    if (problem !== undefined) return { ok: false, problem, line: index + 1 }
    lines.push(line)
  }
  return { ok: true, lines }
}

function lineProblem(line: string): MemoryLineProblem | undefined {
  if (line === '') return 'empty_line'
  if (CONTROL.test(line)) return 'control_characters'
  if (INVISIBLE.test(line)) return 'invisible_characters'
  if ([...line].length > MAX_MEMORY_LINE_LENGTH) return 'line_too_long'
  if (line.includes('```') || line.includes('~~~')) return 'code_fence'
  if (line.includes('<!--') || line.includes('-->')) return 'html_comment'
  return undefined
}

/**
 * pending -> approved (Approve tapped and the lines written) | rejected
 * | expired (TTL) | cancelled (its session is gone). An approval whose write
 * failed goes back to pending.
 */
export type MemoryProposalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'

export interface MemoryProposalSnapshot {
  readonly id: string
  /** The channel process that showed it; only it can resolve it. */
  readonly session: string
  readonly chatId: string
  /** Already checked (`checkMemoryLines`); kept only while pending. */
  readonly lines: readonly string[]
  /** How many lines were proposed; kept after the lines are dropped. */
  readonly lineCount: number
  readonly state: MemoryProposalState
  readonly createdAt: number
  readonly resolvedBy: SenderId | undefined
  readonly closedAt: number | undefined
  readonly prompt: PromptRef | undefined
  readonly revision: number
}

export class InvalidMemoryTransitionError extends DomainError {
  constructor(
    readonly from: MemoryProposalState,
    readonly action: string,
  ) {
    super(`Cannot ${action} a memory proposal that is ${from}`)
  }
}

export interface OpenMemoryProposalInput {
  readonly id: string
  readonly session: string
  readonly chatId: string
  /** Already checked with `checkMemoryLines`. */
  readonly lines: readonly string[]
  readonly now: number
}

/**
 * Lines Claude proposes for the project's `CLAUDE.md` (F12). Nothing is
 * written unless the owner taps Approve on the message that shows every
 * line. Immutable; every transition bumps the revision for compare-and-set.
 */
export class MemoryProposal {
  readonly #data: MemoryProposalSnapshot

  private constructor(data: MemoryProposalSnapshot) {
    this.#data = data
  }

  static open(input: OpenMemoryProposalInput): MemoryProposal {
    if (!isMemoryProposalId(input.id)) throw new DomainError('Invalid memory proposal id')
    const checked = checkMemoryLines(input.lines)
    if (!checked.ok || checked.lines.join('\n') !== input.lines.join('\n')) {
      throw new DomainError('Memory lines must be checked before a proposal is opened')
    }
    return new MemoryProposal({
      id: input.id,
      session: input.session,
      chatId: input.chatId,
      lines: [...checked.lines],
      lineCount: checked.lines.length,
      state: 'pending',
      createdAt: input.now,
      resolvedBy: undefined,
      closedAt: undefined,
      prompt: undefined,
      revision: 0,
    })
  }

  static restore(snapshot: MemoryProposalSnapshot): MemoryProposal {
    return new MemoryProposal(snapshot)
  }

  toSnapshot(): MemoryProposalSnapshot {
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

  get lines(): readonly string[] {
    return this.#data.lines
  }

  get lineCount(): number {
    return this.#data.lineCount
  }

  get state(): MemoryProposalState {
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
    return this.isPending && now >= this.#data.createdAt + MEMORY_PROPOSAL_TTL_MS
  }

  /** Claimed for writing; `writeFailed` undoes it if the file could not be written. */
  approve(by: SenderId, now: number): MemoryProposal {
    if (!this.isPending) this.#invalid('approve')
    return this.#apply({ state: 'approved', resolvedBy: by, closedAt: now })
  }

  writeFailed(): MemoryProposal {
    if (this.state !== 'approved') this.#invalid('record a failed write for')
    return this.#apply({ state: 'pending', resolvedBy: undefined, closedAt: undefined })
  }

  reject(by: SenderId, now: number): MemoryProposal {
    if (!this.isPending) this.#invalid('reject')
    return this.#apply({ state: 'rejected', resolvedBy: by, closedAt: now })
  }

  expire(now: number): MemoryProposal {
    if (!this.isPending) this.#invalid('expire')
    return this.#apply({ state: 'expired', closedAt: now })
  }

  /** Its session is gone, or the prompt could not be shown. */
  cancel(now: number): MemoryProposal {
    if (!this.isPending) this.#invalid('cancel')
    return this.#apply({ state: 'cancelled', closedAt: now })
  }

  /** Remembers where the buttons were posted. Not a state transition. */
  withPrompt(prompt: PromptRef): MemoryProposal {
    return this.#apply({ prompt })
  }

  #invalid(action: string): never {
    throw new InvalidMemoryTransitionError(this.state, action)
  }

  #apply(changes: Partial<MemoryProposalSnapshot>): MemoryProposal {
    return new MemoryProposal({ ...this.#data, ...changes, revision: this.#data.revision + 1 })
  }
}
