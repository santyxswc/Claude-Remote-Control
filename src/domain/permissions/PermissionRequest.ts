import { DomainError } from '../DomainError.ts'
import type { SenderId } from '../Sender.ts'
import { stateBehavior } from './permissionStates.ts'

export { CONFIRMATION_WINDOW_MS, InvalidPermissionTransitionError } from './permissionStates.ts'

/** An open request becomes `expired` after this long without an answer. */
export const PERMISSION_TTL_MS = 10 * 60_000

/**
 * Claude Code's request ids: "Five lowercase letters drawn from `a`-`z`
 * without `l`" (channels reference, "Permission request fields").
 */
const REQUEST_ID = /^[a-km-z]{5}$/

export function isPermissionRequestId(value: string): boolean {
  return REQUEST_ID.test(value)
}

export type RiskLevel = 'low' | 'high'

/**
 * pending -> approved | denied | resolved_locally | expired, and for high
 * risk pending -> awaiting_confirmation -> approved (a second tap), falling
 * back to pending when the confirmation window passes. A verdict that could
 * not be delivered takes approved | denied back to pending.
 */
export type PermissionState =
  | 'pending'
  | 'awaiting_confirmation'
  | 'approved'
  | 'denied'
  | 'resolved_locally'
  | 'expired'

/** Where a copy of the prompt was posted, so it can be edited later. */
export interface PromptRef {
  readonly chatId: string
  readonly messageId: string
}

export interface PermissionSnapshot {
  readonly id: string
  /** The channel process that relayed it; only that process can deliver its verdict. */
  readonly session: string
  readonly toolName: string
  readonly description: string
  readonly inputPreview: string
  readonly risk: RiskLevel
  readonly state: PermissionState
  readonly createdAt: number
  readonly confirmationRequestedAt: number | undefined
  /** Who gave the verdict (approved or denied). */
  readonly decidedBy: SenderId | undefined
  /** When it was closed, by anyone or by expiry. */
  readonly decidedAt: number | undefined
  readonly prompts: readonly PromptRef[]
  /** Incremented on every change; stores use it as a compare-and-set token. */
  readonly revision: number
}

export interface OpenPermissionInput {
  readonly id: string
  readonly session: string
  readonly toolName: string
  readonly description: string
  readonly inputPreview: string
  readonly risk: RiskLevel
  readonly now: number
}

export class InvalidPermissionRequestIdError extends DomainError {
  constructor() {
    super('A permission request id must be five letters a-z without l')
  }
}

/**
 * A tool approval relayed from Claude Code (GoF State: each state is an
 * object in `permissionStates.ts` that decides which transitions it allows).
 * Immutable: every transition returns a new instance.
 */
export class PermissionRequest {
  readonly #data: PermissionSnapshot

  private constructor(data: PermissionSnapshot) {
    this.#data = data
  }

  static open(input: OpenPermissionInput): PermissionRequest {
    if (!isPermissionRequestId(input.id)) throw new InvalidPermissionRequestIdError()
    return new PermissionRequest({
      id: input.id,
      session: input.session,
      toolName: input.toolName,
      description: input.description,
      inputPreview: input.inputPreview,
      risk: input.risk,
      state: 'pending',
      createdAt: input.now,
      confirmationRequestedAt: undefined,
      decidedBy: undefined,
      decidedAt: undefined,
      prompts: [],
      revision: 0,
    })
  }

  static restore(snapshot: PermissionSnapshot): PermissionRequest {
    return new PermissionRequest(snapshot)
  }

  toSnapshot(): PermissionSnapshot {
    return this.#data
  }

  get id(): string {
    return this.#data.id
  }

  get session(): string {
    return this.#data.session
  }

  get toolName(): string {
    return this.#data.toolName
  }

  get description(): string {
    return this.#data.description
  }

  get inputPreview(): string {
    return this.#data.inputPreview
  }

  get risk(): RiskLevel {
    return this.#data.risk
  }

  get state(): PermissionState {
    return this.#data.state
  }

  get createdAt(): number {
    return this.#data.createdAt
  }

  get confirmationRequestedAt(): number | undefined {
    return this.#data.confirmationRequestedAt
  }

  get decidedBy(): SenderId | undefined {
    return this.#data.decidedBy
  }

  get decidedAt(): number | undefined {
    return this.#data.decidedAt
  }

  get prompts(): readonly PromptRef[] {
    return this.#data.prompts
  }

  get revision(): number {
    return this.#data.revision
  }

  /** Pending or awaiting confirmation: still waiting for an answer. */
  get isOpen(): boolean {
    return this.state === 'pending' || this.state === 'awaiting_confirmation'
  }

  /** Open for longer than the TTL. */
  isDue(now: number): boolean {
    return this.isOpen && now >= this.#data.createdAt + PERMISSION_TTL_MS
  }

  /**
   * First approval. Low risk: approved. High risk: awaiting a second tap,
   * which records nothing as decided yet.
   */
  approve(by: SenderId, now: number): PermissionRequest {
    return this.#apply(stateBehavior(this.state).approve(this.#data, by, now))
  }

  /** The second tap of a high-risk approval. */
  confirm(by: SenderId, now: number): PermissionRequest {
    return this.#apply(stateBehavior(this.state).confirm(this.#data, by, now))
  }

  /** Withdraws a pending confirmation; the request is pending again. */
  cancel(now: number): PermissionRequest {
    return this.#apply(stateBehavior(this.state).cancel(this.#data, now))
  }

  deny(by: SenderId, now: number): PermissionRequest {
    return this.#apply(stateBehavior(this.state).deny(this.#data, by, now))
  }

  /** Closes an open request without a verdict (timeout, or its session is gone). */
  expire(now: number): PermissionRequest {
    return this.#apply(stateBehavior(this.state).expire(this.#data, now))
  }

  /** Someone answered at the terminal first. */
  resolveLocally(now: number): PermissionRequest {
    return this.#apply(stateBehavior(this.state).resolveLocally(this.#data, now))
  }

  /** The verdict could not be sent to Claude Code: nothing was decided. */
  deliveryFailed(): PermissionRequest {
    return this.#apply(stateBehavior(this.state).deliveryFailed(this.#data))
  }

  /**
   * Applies the passage of time: a confirmation whose window passed falls
   * back to pending. Returns this same instance when nothing changes.
   */
  settle(now: number): PermissionRequest {
    const changes = stateBehavior(this.state).settle(this.#data, now)
    return changes === undefined ? this : this.#apply(changes)
  }

  /** Remembers where the prompt was posted. Not a state transition. */
  withPrompts(prompts: readonly PromptRef[]): PermissionRequest {
    return this.#apply({ prompts: [...this.#data.prompts, ...prompts] })
  }

  #apply(changes: Partial<PermissionSnapshot>): PermissionRequest {
    return new PermissionRequest({ ...this.#data, ...changes, revision: this.#data.revision + 1 })
  }
}
