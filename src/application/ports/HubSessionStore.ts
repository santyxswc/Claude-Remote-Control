export interface HubSessionRecord {
  readonly session: string
  readonly topicId: string
  readonly endedAt: number | undefined
}

/**
 * Which channel session used which topic (F14), so a reconnecting session
 * gets its topic back after a hub restart and a new session can clean up
 * what an ended one left in its topic.
 */
export interface HubSessionStore {
  find(session: string): HubSessionRecord | undefined
  /** Registered (again): `endedAt` is cleared. */
  upsert(session: string, topicId: string, at: number): void
  markEnded(session: string, at: number): void
  /** Sessions not marked ended. */
  listOpen(): readonly HubSessionRecord[]
  /** Ended sessions of a topic, newest first, at most `limit`. */
  endedFor(topicId: string, limit: number): readonly string[]
}
