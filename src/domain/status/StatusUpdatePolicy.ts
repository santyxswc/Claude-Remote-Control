import { TokenBucket } from '../TokenBucket.ts'

/** A change is sent once nothing else changed for this long (trailing-edge debounce). */
export const STATUS_DEBOUNCE_MS = 2_000
/** ...but a status that keeps changing is still sent this long after its first change. */
export const STATUS_MAX_WAIT_MS = 10_000
/** At most one edit per chat per this many milliseconds. */
export const STATUS_MIN_INTERVAL_MS = 5_000
/** Edits across every chat: a burst of this many, then one per `STATUS_GLOBAL_REFILL_MS`. */
export const STATUS_GLOBAL_BURST = 10
export const STATUS_GLOBAL_REFILL_MS = 3_000

interface ChatState {
  lastSent: string | undefined
  lastSentAt: number | undefined
  pending: { text: string; firstAt: number; lastChangeAt: number } | undefined
  floodUntil: number
}

const GLOBAL = 'global'

/**
 * When to edit the pinned status message of each chat (F9). Pure: callers
 * pass the time and the freshly rendered text, and the policy keeps only the
 * latest render per chat. An edit is due when the text differs from the one
 * sent, nothing changed for `STATUS_DEBOUNCE_MS` (or the change is
 * `STATUS_MAX_WAIT_MS` old), the chat's last edit is `STATUS_MIN_INTERVAL_MS`
 * old, no flood wait is running and the global budget allows it. An unchanged
 * render never edits, so there is no "updated at" heartbeat.
 */
export class StatusUpdatePolicy {
  readonly #chats = new Map<string, ChatState>()
  readonly #budget = new TokenBucket({
    burst: STATUS_GLOBAL_BURST,
    refillMs: STATUS_GLOBAL_REFILL_MS,
    noticeWindowMs: 0,
  })
  #globalFloodUntil = 0

  /** The latest render for `chatId`; intermediate renders are dropped. */
  observe(chatId: string, text: string, now: number): void {
    const chat = this.#chat(chatId)
    if (text === chat.lastSent) {
      chat.pending = undefined
      return
    }
    if (chat.pending?.text === text) return
    chat.pending = { text, firstAt: chat.pending?.firstAt ?? now, lastChangeAt: now }
  }

  /** The text to send now, if an edit is due; taking it spends global budget. */
  due(chatId: string, now: number): string | undefined {
    const chat = this.#chats.get(chatId)
    const pending = chat?.pending
    if (chat === undefined || pending === undefined) return undefined
    if (now < chat.floodUntil || now < this.#globalFloodUntil) return undefined
    if (chat.lastSentAt !== undefined && now - chat.lastSentAt < STATUS_MIN_INTERVAL_MS) {
      return undefined
    }
    const settled = now - pending.lastChangeAt >= STATUS_DEBOUNCE_MS
    const overdue = now - pending.firstAt >= STATUS_MAX_WAIT_MS
    if (!settled && !overdue) return undefined
    if (!this.#budget.take(GLOBAL, now).allowed) return undefined
    return pending.text
  }

  /** `text` is now what the chat shows. */
  sent(chatId: string, text: string, now: number): void {
    const chat = this.#chat(chatId)
    chat.lastSent = text
    chat.lastSentAt = now
    if (chat.pending?.text === text) chat.pending = undefined
  }

  /** A 429: nothing is edited (in any chat: the limit is the bot's) before `until`. */
  floodWait(chatId: string, until: number): void {
    this.#chat(chatId).floodUntil = until
    this.#globalFloodUntil = Math.max(this.#globalFloodUntil, until)
  }

  /** A failed edit: the render stays pending and the next one waits the interval. */
  failed(chatId: string, now: number): void {
    this.#chat(chatId).lastSentAt = now
  }

  forget(chatId: string): void {
    this.#chats.delete(chatId)
  }

  #chat(chatId: string): ChatState {
    let chat = this.#chats.get(chatId)
    if (chat === undefined) {
      chat = { lastSent: undefined, lastSentAt: undefined, pending: undefined, floodUntil: 0 }
      this.#chats.set(chatId, chat)
    }
    return chat
  }
}
