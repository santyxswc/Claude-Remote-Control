import type { Database } from 'bun:sqlite'
import type { StatusMessageStore } from '../../application/ports/StatusMessageStore.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'

interface StatusMessageRow {
  chat_id: string
  message_id: string
}

/** One pinned status message per chat (F9). Ids as TEXT, like every Telegram id here. */
export class SqliteStatusMessageStore implements StatusMessageStore {
  constructor(private readonly db: Database) {}

  put(ref: PromptRef, at: number): void {
    this.db
      .query(
        `INSERT INTO status_messages (chat_id, message_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET message_id = excluded.message_id,
           created_at = excluded.created_at`,
      )
      .run(ref.chatId, ref.messageId, at)
  }

  find(chatId: string): PromptRef | undefined {
    const row = this.db
      .query<StatusMessageRow, [string]>(
        'SELECT chat_id, message_id FROM status_messages WHERE chat_id = ?',
      )
      .get(chatId)
    return row === null ? undefined : { chatId: row.chat_id, messageId: row.message_id }
  }

  list(): readonly PromptRef[] {
    return this.db
      .query<StatusMessageRow, []>(
        'SELECT chat_id, message_id FROM status_messages ORDER BY created_at, chat_id',
      )
      .all()
      .map((row) => ({ chatId: row.chat_id, messageId: row.message_id }))
  }

  remove(chatId: string): void {
    this.db.query('DELETE FROM status_messages WHERE chat_id = ?').run(chatId)
  }
}
