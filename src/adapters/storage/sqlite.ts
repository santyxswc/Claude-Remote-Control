import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, openSync } from 'node:fs'
import { SECRET_FILE_MODE } from './stateDir.ts'

export const DATABASE_FILE = 'bridge.sqlite'

/** How long a connection waits for another process's write lock before failing. */
export const BUSY_TIMEOUT_MS = 5000

/**
 * Schema migrations, applied in order; `PRAGMA user_version` records how
 * many have run. Never edit a released migration: append a new one.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE allowed_senders (
    id TEXT PRIMARY KEY CHECK (id GLOB '[1-9]*' AND id NOT GLOB '*[^0-9]*'),
    username TEXT,
    display_name TEXT NOT NULL,
    added_at INTEGER NOT NULL
  );

  CREATE TABLE pairings (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL
      CHECK (state IN ('pending', 'claimed', 'confirmed', 'expired', 'cancelled')),
    code_hash TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    failed_attempts INTEGER NOT NULL,
    claimant_id TEXT,
    claimant_username TEXT,
    claimant_display_name TEXT,
    claimed_at INTEGER,
    ended_at INTEGER,
    cancel_reason TEXT,
    revision INTEGER NOT NULL
  );
  CREATE INDEX pairings_by_state ON pairings (state, created_at);

  CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    event TEXT NOT NULL,
    details TEXT NOT NULL
  );
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

  CREATE TABLE poller_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    role TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
  );
  `,
  // F3: relayed permission requests. Prompts is a JSON array of {chatId, messageId}.
  `
  CREATE TABLE permission_requests (
    id TEXT PRIMARY KEY CHECK (length(id) = 5 AND id NOT GLOB '*[^a-km-z]*'),
    session TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    description TEXT NOT NULL,
    input_preview TEXT NOT NULL,
    risk TEXT NOT NULL CHECK (risk IN ('low', 'high')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'awaiting_confirmation', 'approved',
      'denied', 'resolved_locally', 'expired')),
    created_at INTEGER NOT NULL,
    confirmation_requested_at INTEGER,
    decided_by TEXT,
    decided_at INTEGER,
    prompts TEXT NOT NULL,
    revision INTEGER NOT NULL
  );
  CREATE INDEX permission_requests_by_state ON permission_requests (state, created_at);
  `,
  // F7: questions asked with ask_choice. Options is a JSON array of labels; answer a JSON
  // object or NULL; prompt a JSON {chatId, messageId} or NULL. The question and the labels
  // stay only while the choice is open.
  `
  CREATE TABLE choices (
    id TEXT PRIMARY KEY CHECK (length(id) = 10 AND id NOT GLOB '*[^a-z2-7]*'),
    session TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    allow_other INTEGER NOT NULL CHECK (allow_other IN (0, 1)),
    state TEXT NOT NULL
      CHECK (state IN ('pending', 'awaiting_text', 'answered', 'expired', 'cancelled')),
    created_at INTEGER NOT NULL,
    answer TEXT,
    answered_by TEXT,
    closed_at INTEGER,
    prompt TEXT,
    revision INTEGER NOT NULL
  );
  CREATE INDEX choices_by_state ON choices (state, created_at);
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length

export class UnsupportedSchemaError extends Error {
  constructor(found: number) {
    super(
      `The database schema (v${found}) is newer than this version supports (v${SCHEMA_VERSION})`,
    )
    this.name = 'UnsupportedSchemaError'
  }
}

/**
 * Opens (creating if needed) the state database: WAL so the channel and the
 * CLI can read while the other writes, a busy timeout so concurrent writers
 * wait instead of failing, and pending migrations applied.
 *
 * The file is created owner-only before SQLite opens it: SQLite gives the
 * `-wal` and `-shm` files the same permissions as the database file.
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    closeSync(openSync(path, 'a', SECRET_FILE_MODE))
    chmodSync(path, SECRET_FILE_MODE)
  }
  const db = new Database(path, { create: true, strict: true })
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.run('PRAGMA journal_mode = WAL')
    db.run('PRAGMA foreign_keys = ON')
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}

function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
}

/** Safe to run from two processes at once: the version is re-read under the write lock. */
export function migrate(db: Database): void {
  const apply = db.transaction(() => {
    const current = userVersion(db)
    if (current > SCHEMA_VERSION) throw new UnsupportedSchemaError(current)
    for (let version = current; version < SCHEMA_VERSION; version++) {
      db.run(MIGRATIONS[version] ?? '')
      db.run(`PRAGMA user_version = ${version + 1}`)
    }
  })
  if (userVersion(db) !== SCHEMA_VERSION) apply.immediate()
}
