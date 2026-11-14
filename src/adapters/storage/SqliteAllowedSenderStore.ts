import type { Database } from 'bun:sqlite'
import type { AllowedSenderStore } from '../../application/ports/AllowedSenderStore.ts'
import type { AllowedSender } from '../../domain/AllowedSender.ts'
import type { SenderId } from '../../domain/Sender.ts'

interface AllowedSenderRow {
  id: string
  username: string | null
  display_name: string
  added_at: number
}

/** Ids are stored as TEXT so 64-bit Telegram ids never lose precision. */
export class SqliteAllowedSenderStore implements AllowedSenderStore {
  constructor(private readonly db: Database) {}

  add(sender: AllowedSender): void {
    this.db
      .query(
        `INSERT INTO allowed_senders (id, username, display_name, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET username = excluded.username,
           display_name = excluded.display_name`,
      )
      .run(sender.id, sender.username ?? null, sender.displayName, sender.addedAt)
  }

  remove(id: SenderId): boolean {
    return this.db.query('DELETE FROM allowed_senders WHERE id = ?').run(id).changes === 1
  }

  has(id: SenderId): boolean {
    return this.db.query('SELECT 1 FROM allowed_senders WHERE id = ?').get(id) !== null
  }

  list(): readonly AllowedSender[] {
    return this.db
      .query<AllowedSenderRow, []>(
        'SELECT id, username, display_name, added_at FROM allowed_senders ORDER BY added_at, id',
      )
      .all()
      .map((row) => ({
        id: row.id,
        username: row.username ?? undefined,
        displayName: row.display_name,
        addedAt: row.added_at,
      }))
  }
}
