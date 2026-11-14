import { DomainError } from './DomainError.ts'
import {
  RATE_LIMIT_BURST,
  RATE_LIMIT_NOTICE_WINDOW_MS,
  RATE_LIMIT_REFILL_MS,
} from './inboundLimits.ts'

export interface RateLimitPolicy {
  /** Messages a sender can send at once. */
  readonly burst: number
  /** One more message is admitted every this many milliseconds. */
  readonly refillMs: number
  /** Over the limit, tell the sender at most once per this many milliseconds. */
  readonly noticeWindowMs: number
}

export const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  burst: RATE_LIMIT_BURST,
  refillMs: RATE_LIMIT_REFILL_MS,
  noticeWindowMs: RATE_LIMIT_NOTICE_WINDOW_MS,
}

/** `notify` is true for the first drop of a notice window: the one time to tell the sender. */
export type RateDecision = { readonly allowed: true } | { readonly allowed: false; notify: boolean }

interface Bucket {
  tokens: number
  updatedAt: number
  noticeAt: number | undefined
}

export class InvalidRateLimitPolicyError extends DomainError {
  constructor() {
    super('A rate limit needs a burst >= 1 and positive intervals')
  }
}

/**
 * Per-key token bucket. Time comes from the caller, so it is pure and
 * deterministic. Keys are allowlisted sender ids, so the map stays small.
 */
export class TokenBucket {
  readonly #buckets = new Map<string, Bucket>()

  constructor(private readonly policy: RateLimitPolicy = DEFAULT_RATE_LIMIT) {
    if (policy.burst < 1 || policy.refillMs <= 0 || policy.noticeWindowMs < 0) {
      throw new InvalidRateLimitPolicyError()
    }
  }

  take(key: string, now: number): RateDecision {
    const { burst, refillMs, noticeWindowMs } = this.policy
    const bucket = this.#buckets.get(key) ?? { tokens: burst, updatedAt: now, noticeAt: undefined }
    const elapsed = Math.max(0, now - bucket.updatedAt)
    bucket.tokens = Math.min(burst, bucket.tokens + elapsed / refillMs)
    bucket.updatedAt = now
    this.#buckets.set(key, bucket)

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { allowed: true }
    }
    const notify = bucket.noticeAt === undefined || now - bucket.noticeAt >= noticeWindowMs
    if (notify) bucket.noticeAt = now
    return { allowed: false, notify }
  }
}
