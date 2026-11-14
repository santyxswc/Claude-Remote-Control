import type { Database } from 'bun:sqlite'
import type { AuditEntry, AuditLog } from '../../application/ports/AuditLog.ts'

/**
 * Append-only audit trail. There is deliberately no update or delete method,
 * and triggers in the schema reject both at the database level too.
 */
export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: Database) {}

  append(entry: AuditEntry): void {
    this.db
      .query('INSERT INTO audit_log (at, actor, event, details) VALUES (?, ?, ?, ?)')
      .run(entry.at, entry.actor, entry.event, JSON.stringify(entry.details))
  }
}
