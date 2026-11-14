/**
 * Every inbound throttling constant, in one place.
 *
 * Rate limit: a per-sender token bucket. A sender may send a burst of
 * `RATE_LIMIT_BURST` messages; after that one message is admitted every
 * `RATE_LIMIT_REFILL_MS`. Over the limit, messages are dropped and the sender
 * is told to slow down at most once per `RATE_LIMIT_NOTICE_WINDOW_MS`.
 */
export const RATE_LIMIT_BURST = 20
export const RATE_LIMIT_REFILL_MS = 3_000
export const RATE_LIMIT_NOTICE_WINDOW_MS = 60_000

/** At most one "dropped message" log line per sender (or chat) per window. */
export const DROPPED_LOG_WINDOW_MS = 60_000

/** At most one "only text is supported" reply per sender per window (an album is many messages). */
export const UNSUPPORTED_NOTICE_WINDOW_MS = 60_000

/** Throttles forget keys beyond this many, so a flood of distinct ids cannot grow memory forever. */
export const THROTTLE_MAX_KEYS = 1024
