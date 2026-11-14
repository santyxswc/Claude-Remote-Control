import type { Database } from 'bun:sqlite'
import type { BindingGroup, GroupBindingStore } from '../../application/ports/GroupBindingStore.ts'
import type { HubGroup, HubGroupStore } from '../../application/ports/HubGroupStore.ts'
import type { HubMessageLedger } from '../../application/ports/HubMessageLedger.ts'
import type { HubSessionRecord, HubSessionStore } from '../../application/ports/HubSessionStore.ts'
import type { HubTopic, HubTopicStore } from '../../application/ports/HubTopicStore.ts'
import type { StatusMessageStore } from '../../application/ports/StatusMessageStore.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import { SqlitePairingStore } from './SqlitePairingStore.ts'

/** F14 stores. Ids are TEXT, like every Telegram id here. */

export class SqliteHubGroupStore implements HubGroupStore {
  constructor(private readonly db: Database) {}

  load(): HubGroup | undefined {
    const row = this.db
      .query<{ chat_id: string; title: string; bound_by: string; bound_at: number }, []>(
        'SELECT chat_id, title, bound_by, bound_at FROM hub_group WHERE id = 1',
      )
      .get()
    return row === null
      ? undefined
      : { chatId: row.chat_id, title: row.title, boundBy: row.bound_by, boundAt: row.bound_at }
  }

  save(group: HubGroup): void {
    this.db
      .query(
        `INSERT INTO hub_group (id, chat_id, title, bound_by, bound_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET chat_id = excluded.chat_id, title = excluded.title,
           bound_by = excluded.bound_by, bound_at = excluded.bound_at`,
      )
      .run(group.chatId, group.title, group.boundBy, group.boundAt)
  }

  clear(): boolean {
    return this.db.query('DELETE FROM hub_group WHERE id = 1').run().changes === 1
  }
}

interface TopicRow {
  topic_id: string
  chat_id: string
  project_key: string
  slot: number
  name: string
  created_at: number
}

const toTopic = (row: TopicRow): HubTopic => ({
  topicId: row.topic_id,
  chatId: row.chat_id,
  projectKey: row.project_key,
  slot: row.slot,
  name: row.name,
  createdAt: row.created_at,
})

export class SqliteHubTopicStore implements HubTopicStore {
  constructor(private readonly db: Database) {}

  listForProject(chatId: string, projectKey: string): readonly HubTopic[] {
    return this.db
      .query<TopicRow, [string, string]>(
        'SELECT * FROM hub_topics WHERE chat_id = ? AND project_key = ? ORDER BY slot',
      )
      .all(chatId, projectKey)
      .map(toTopic)
  }

  listAll(chatId: string): readonly HubTopic[] {
    return this.db
      .query<TopicRow, [string]>('SELECT * FROM hub_topics WHERE chat_id = ? ORDER BY created_at')
      .all(chatId)
      .map(toTopic)
  }

  insert(topic: HubTopic): void {
    this.db
      .query(
        `INSERT INTO hub_topics (topic_id, chat_id, project_key, slot, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(topic.topicId, topic.chatId, topic.projectKey, topic.slot, topic.name, topic.createdAt)
  }

  replaceTopicId(chatId: string, oldTopicId: string, newTopicId: string): void {
    this.db
      .query('UPDATE hub_topics SET topic_id = ? WHERE chat_id = ? AND topic_id = ?')
      .run(newTopicId, chatId, oldTopicId)
  }
}

export class SqliteHubSessionStore implements HubSessionStore {
  constructor(private readonly db: Database) {}

  find(session: string): HubSessionRecord | undefined {
    const row = this.db
      .query<{ session: string; topic_id: string; ended_at: number | null }, [string]>(
        'SELECT session, topic_id, ended_at FROM hub_sessions WHERE session = ?',
      )
      .get(session)
    return row === null
      ? undefined
      : { session: row.session, topicId: row.topic_id, endedAt: row.ended_at ?? undefined }
  }

  upsert(session: string, topicId: string, at: number): void {
    this.db
      .query(
        `INSERT INTO hub_sessions (session, topic_id, registered_at, ended_at) VALUES (?, ?, ?, NULL)
         ON CONFLICT (session) DO UPDATE SET topic_id = excluded.topic_id,
           registered_at = excluded.registered_at, ended_at = NULL`,
      )
      .run(session, topicId, at)
  }

  markEnded(session: string, at: number): void {
    this.db
      .query('UPDATE hub_sessions SET ended_at = ? WHERE session = ? AND ended_at IS NULL')
      .run(at, session)
  }

  listOpen(): readonly HubSessionRecord[] {
    return this.db
      .query<{ session: string; topic_id: string }, []>(
        'SELECT session, topic_id FROM hub_sessions WHERE ended_at IS NULL ORDER BY registered_at',
      )
      .all()
      .map((row) => ({ session: row.session, topicId: row.topic_id, endedAt: undefined }))
  }

  endedFor(topicId: string, limit: number): readonly string[] {
    return this.db
      .query<{ session: string }, [string, number]>(
        `SELECT session FROM hub_sessions WHERE topic_id = ? AND ended_at IS NOT NULL
         ORDER BY ended_at DESC LIMIT ?`,
      )
      .all(topicId, limit)
      .map((row) => row.session)
  }
}

export class SqliteHubMessageLedger implements HubMessageLedger {
  constructor(private readonly db: Database) {}

  record(chatId: string, messageId: string, topicId: string, at: number): void {
    this.db
      .query(
        `INSERT INTO hub_messages (chat_id, message_id, topic_id, at) VALUES (?, ?, ?, ?)
         ON CONFLICT (chat_id, message_id) DO UPDATE SET topic_id = excluded.topic_id, at = excluded.at`,
      )
      .run(chatId, messageId, topicId, at)
  }

  topicOf(chatId: string, messageId: string): string | undefined {
    return (
      this.db
        .query<{ topic_id: string }, [string, string]>(
          'SELECT topic_id FROM hub_messages WHERE chat_id = ? AND message_id = ?',
        )
        .get(chatId, messageId)?.topic_id ?? undefined
    )
  }

  prune(before: number): number {
    return this.db.query('DELETE FROM hub_messages WHERE at < ?').run(before).changes
  }
}

/**
 * The pinned status (F9) of one topic, for a spoke: every spoke shares the
 * database and sees its topic as the owner's chat, so the rows are scoped by
 * topic. The scope is read on each call: it is known once the spoke is
 * registered, and nothing is listed before.
 */
export class SqliteTopicStatusMessageStore implements StatusMessageStore {
  constructor(
    private readonly db: Database,
    private readonly topic: () => string | undefined,
  ) {}

  put(ref: PromptRef, at: number): void {
    const topic = this.topic()
    if (topic === undefined) return
    this.db
      .query(
        `INSERT INTO hub_status_messages (topic_id, chat_id, message_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (topic_id, chat_id) DO UPDATE SET message_id = excluded.message_id,
           created_at = excluded.created_at`,
      )
      .run(topic, ref.chatId, ref.messageId, at)
  }

  find(chatId: string): PromptRef | undefined {
    const topic = this.topic()
    if (topic === undefined) return undefined
    const row = this.db
      .query<{ message_id: string }, [string, string]>(
        'SELECT message_id FROM hub_status_messages WHERE topic_id = ? AND chat_id = ?',
      )
      .get(topic, chatId)
    return row === null ? undefined : { chatId, messageId: row.message_id }
  }

  list(): readonly PromptRef[] {
    const topic = this.topic()
    if (topic === undefined) return []
    return this.db
      .query<{ chat_id: string; message_id: string }, [string]>(
        'SELECT chat_id, message_id FROM hub_status_messages WHERE topic_id = ? ORDER BY created_at',
      )
      .all(topic)
      .map((row) => ({ chatId: row.chat_id, messageId: row.message_id }))
  }

  remove(chatId: string): void {
    const topic = this.topic()
    if (topic === undefined) return
    this.db
      .query('DELETE FROM hub_status_messages WHERE topic_id = ? AND chat_id = ?')
      .run(topic, chatId)
  }
}

export class SqliteGroupBindingStore extends SqlitePairingStore implements GroupBindingStore {
  constructor(db: Database) {
    super(db, 'group_bindings')
  }

  setGroup(bindingId: string, group: BindingGroup): void {
    this.db
      .query('UPDATE group_bindings SET group_id = ?, group_title = ? WHERE id = ?')
      .run(group.chatId, group.title, bindingId)
  }

  groupOf(bindingId: string): BindingGroup | undefined {
    const row = this.db
      .query<{ group_id: string | null; group_title: string | null }, [string]>(
        'SELECT group_id, group_title FROM group_bindings WHERE id = ?',
      )
      .get(bindingId)
    if (row === null || row.group_id === null) return undefined
    return { chatId: row.group_id, title: row.group_title ?? '' }
  }
}
