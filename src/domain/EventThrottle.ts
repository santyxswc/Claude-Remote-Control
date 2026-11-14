import { THROTTLE_MAX_KEYS } from './inboundLimits.ts'

/**
 * `emit`: let this occurrence through; `suppressed` counts the occurrences
 * swallowed since the previous one that was let through.
 */
export type ThrottleDecision =
  | { readonly emit: true; suppressed: number }
  | { readonly emit: false }

interface Entry {
  emittedAt: number
  suppressed: number
}

/**
 * Lets at most one occurrence per key through per window and counts the
 * rest. Used to keep floods out of the log and to avoid repeating notices.
 * Beyond `maxKeys` it forgets expired keys first, then the oldest ones (their
 * pending suppressed counts are lost, which only makes a later line undercount).
 */
export class EventThrottle {
  readonly #entries = new Map<string, Entry>()

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys: number = THROTTLE_MAX_KEYS,
  ) {}

  record(key: string, now: number): ThrottleDecision {
    const entry = this.#entries.get(key)
    if (entry !== undefined && now - entry.emittedAt < this.windowMs) {
      entry.suppressed += 1
      return { emit: false }
    }
    const suppressed = entry?.suppressed ?? 0
    this.#entries.delete(key) // re-inserted below, so iteration order stays oldest-first
    this.#prune(now)
    this.#entries.set(key, { emittedAt: now, suppressed: 0 })
    return { emit: true, suppressed }
  }

  get size(): number {
    return this.#entries.size
  }

  #prune(now: number): void {
    if (this.#entries.size < this.maxKeys) return
    for (const [key, entry] of this.#entries) {
      if (now - entry.emittedAt >= this.windowMs) this.#entries.delete(key)
    }
    for (const key of this.#entries.keys()) {
      if (this.#entries.size < this.maxKeys) break
      this.#entries.delete(key)
    }
  }
}
