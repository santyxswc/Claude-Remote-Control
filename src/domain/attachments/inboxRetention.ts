/** Files in the inbox are deleted after this long. */
export const INBOX_TTL_MS = 24 * 60 * 60_000

/** Beyond this total the oldest files are deleted. */
export const INBOX_QUOTA_BYTES = 200_000_000

export interface InboxEntry {
  /** The file name inside the session's inbox (one we generated). */
  readonly name: string
  readonly bytes: number
  /** Epoch milliseconds. */
  readonly modifiedAt: number
}

export interface RetentionPolicy {
  readonly ttlMs: number
  readonly quotaBytes: number
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  ttlMs: INBOX_TTL_MS,
  quotaBytes: INBOX_QUOTA_BYTES,
}

/** Names to delete: every file older than the TTL, then the oldest until the rest fit the quota. */
export function selectForDeletion(
  entries: readonly InboxEntry[],
  now: number,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): string[] {
  const expired = entries.filter((entry) => now - entry.modifiedAt >= policy.ttlMs)
  const kept = entries
    .filter((entry) => now - entry.modifiedAt < policy.ttlMs)
    .sort((a, b) => a.modifiedAt - b.modifiedAt || a.name.localeCompare(b.name))
  let total = kept.reduce((sum, entry) => sum + entry.bytes, 0)
  const overQuota: InboxEntry[] = []
  for (const entry of kept) {
    if (total <= policy.quotaBytes) break
    overQuota.push(entry)
    total -= entry.bytes
  }
  return [...expired, ...overQuota].map((entry) => entry.name)
}
