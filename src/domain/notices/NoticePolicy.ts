import { EventThrottle } from '../EventThrottle.ts'

/** The same notice text again within this window is dropped. */
export const DUPLICATE_NOTICE_WINDOW_MS = 30_000

/** No notice right after the owner wrote (chat message or terminal prompt): they are there. */
export const OWNER_QUIET_MS = 3_000

/**
 * A `permission_prompt` notice is dropped when a prompt with buttons went out
 * this recently: F3 already told the owner. Claude Code sends the
 * notification about six seconds after the dialog opened.
 */
export const PERMISSION_NOTICE_COVER_MS = 15_000

/** Body length of a notice, so header + body fit one Telegram message even after redaction. */
export const NOTICE_BODY_MAX_LENGTH = 3_500

/**
 * `finished`: the turn ended (`Stop`). `attention`: Claude waits for the
 * owner (`Notification`); `idle` marks the 60-second idle reminder.
 */
export type NoticeCandidate =
  | { readonly kind: 'finished'; readonly text: string }
  | {
      readonly kind: 'attention'
      readonly text: string
      readonly trigger: 'idle' | 'permission' | 'other'
      /** When this session last relayed a permission prompt with buttons, if any is open. */
      readonly permissionRelayedAt?: number | undefined
    }

export type Suppression =
  /** `finished`, but Claude already answered in the chat during that turn. */
  | 'replied_this_turn'
  /** The idle reminder, but the end of the turn was already told (notice or reply). */
  | 'turn_end_already_told'
  /** F3 relayed the prompt with buttons moments ago. */
  | 'permission_already_relayed'
  /** The owner wrote moments ago. */
  | 'owner_just_wrote'
  /** The same text was sent moments ago. */
  | 'duplicate'

/**
 * The debounce of plan F4 step 4, as a pure policy: callers report what
 * happened and ask whether a notice should go out, passing the time.
 */
export class NoticePolicy {
  readonly #duplicates = new EventThrottle(DUPLICATE_NOTICE_WINDOW_MS)
  #lastReplyAt: number | undefined
  #lastOwnerMessageAt: number | undefined
  #lastTurnEndAt: number | undefined
  #turnEndTold = false

  /** Claude sent a message to the chat (the `reply` tool). */
  replied(now: number): void {
    this.#lastReplyAt = now
  }

  /** The owner wrote: a chat message forwarded to the session, or a prompt at the terminal. */
  ownerWrote(now: number): void {
    this.#lastOwnerMessageAt = now
    // A new turn is starting; an interrupted one fires no `Stop`, so do not carry the flag over.
    this.#turnEndTold = false
  }

  /** Whether to send `candidate` now; `undefined` means send. */
  decide(candidate: NoticeCandidate, now: number): Suppression | undefined {
    const suppression = this.#suppression(candidate, now)
    if (candidate.kind === 'finished') {
      this.#lastTurnEndAt = now
      this.#turnEndTold = suppression === undefined || suppression === 'replied_this_turn'
    }
    return suppression
  }

  #suppression(candidate: NoticeCandidate, now: number): Suppression | undefined {
    if (candidate.kind === 'finished' && this.#repliedSinceLastTurnEnd()) {
      return 'replied_this_turn'
    }
    if (candidate.kind === 'attention') {
      if (candidate.trigger === 'idle' && this.#turnEndTold) return 'turn_end_already_told'
      const relayedAt = candidate.permissionRelayedAt
      if (
        candidate.trigger === 'permission' &&
        relayedAt !== undefined &&
        now - relayedAt < PERMISSION_NOTICE_COVER_MS
      ) {
        return 'permission_already_relayed'
      }
    }
    if (this.#lastOwnerMessageAt !== undefined && now - this.#lastOwnerMessageAt < OWNER_QUIET_MS) {
      return 'owner_just_wrote'
    }
    if (!this.#duplicates.record(`${candidate.kind}\n${candidate.text}`, now).emit) {
      return 'duplicate'
    }
    return undefined
  }

  /** Any reply after the previous turn ended belongs to the turn that is ending now. */
  #repliedSinceLastTurnEnd(): boolean {
    if (this.#lastReplyAt === undefined) return false
    return this.#lastTurnEndAt === undefined || this.#lastReplyAt > this.#lastTurnEndAt
  }
}
