import type { Database } from 'bun:sqlite'
import type { Clock } from '../../application/ports/Clock.ts'
import type {
  PollerLock,
  PollerLockHolder,
  PollerLockResult,
  PollerRole,
} from '../../application/ports/PollerLock.ts'

/** A holder that has not refreshed for this long is stale even if its pid looks alive. */
export const LOCK_STALE_AFTER_MS = 60_000

/** How often a holder should call `refresh`. */
export const LOCK_HEARTBEAT_MS = 10_000

interface LockRow {
  pid: number
  role: string
  started_at: number
  heartbeat_at: number
}

export interface SqlitePollerLockOptions {
  readonly pid: number
  readonly clock: Clock
  readonly isProcessAlive: (pid: number) => boolean
  readonly staleAfterMs?: number
}

/**
 * The single-poller lock as one row in the shared database. Acquisition runs
 * in an IMMEDIATE transaction, so two processes cannot both see the lock free
 * and both take it (a lock file cannot offer that check-and-replace
 * atomically). A holder is stale when its pid is dead, or when its heartbeat
 * is old, which also covers a recycled pid.
 */
export class SqlitePollerLock implements PollerLock {
  readonly #db: Database
  readonly #options: SqlitePollerLockOptions

  constructor(db: Database, options: SqlitePollerLockOptions) {
    this.#db = db
    this.#options = options
  }

  tryAcquire(role: PollerRole): PollerLockResult {
    const acquire = this.#db.transaction((): PollerLockResult => {
      const now = this.#options.clock.now()
      const row = this.#read()
      if (row !== null && row.pid !== this.#options.pid && this.#isLive(row, now)) {
        return { acquired: false, holder: toHolder(row) }
      }
      this.#db
        .query(
          `INSERT INTO poller_lock (id, pid, role, started_at, heartbeat_at) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, role = excluded.role,
             started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
        )
        .run(this.#options.pid, role, now, now)
      return { acquired: true }
    })
    return acquire.immediate()
  }

  refresh(): boolean {
    const result = this.#db
      .query('UPDATE poller_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?')
      .run(this.#options.clock.now(), this.#options.pid)
    return result.changes === 1
  }

  /** The live holder, if any; reads only (`hub status`, F14). */
  currentHolder(): PollerLockHolder | undefined {
    const row = this.#read()
    if (row === null || !this.#isLive(row, this.#options.clock.now())) return undefined
    return toHolder(row)
  }

  release(): void {
    this.#db.query('DELETE FROM poller_lock WHERE id = 1 AND pid = ?').run(this.#options.pid)
  }

  #read(): LockRow | null {
    return this.#db
      .query<LockRow, []>(
        'SELECT pid, role, started_at, heartbeat_at FROM poller_lock WHERE id = 1',
      )
      .get()
  }

  #isLive(row: LockRow, now: number): boolean {
    const staleAfter = this.#options.staleAfterMs ?? LOCK_STALE_AFTER_MS
    return now - row.heartbeat_at < staleAfter && this.#options.isProcessAlive(row.pid)
  }
}

function toHolder(row: LockRow): PollerLockHolder {
  const role: PollerRole = row.role === 'cli' ? 'cli' : row.role === 'hub' ? 'hub' : 'channel'
  return { pid: row.pid, role, startedAt: row.started_at }
}
