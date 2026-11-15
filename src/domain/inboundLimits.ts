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

/**
 * A message sent more than this long before the session started to receive
 * messages is left over from an earlier session and is dropped. The margin
 * covers a restart in progress and a PC clock that runs ahead of the chat
 * platform's.
 */
export const STALE_MESSAGE_GRACE_MS = 60_000

/** At most one "dropped message" log line per sender (or chat) per window. */
export const DROPPED_LOG_WINDOW_MS = 60_000

/** At most one "only text is supported" reply per sender per window (an album is many messages). */
export const UNSUPPORTED_NOTICE_WINDOW_MS = 60_000

/** At most one "the brake is engaged, not forwarded" reply per sender per window. */
export const BRAKE_NOTICE_WINDOW_MS = 60_000

/**
 * Incoming files (F10): a per-sender budget on top of the message rate limit
 * (an album is up to 10 files at once; then one file every 30 s), and at
 * most this many downloads at a time per process (the rest wait their turn).
 */
export const ATTACHMENT_BURST = 10
export const ATTACHMENT_REFILL_MS = 30_000
export const MAX_DOWNLOADS_IN_FLIGHT = 2

/** At most one "that file was not accepted" reply per album (or file) per window. */
export const ATTACHMENT_NOTICE_WINDOW_MS = 60_000

/** Throttles forget keys beyond this many, so a flood of distinct ids cannot grow memory forever. */
export const THROTTLE_MAX_KEYS = 1024
