import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteAuditLog } from '../../../src/adapters/storage/SqliteAuditLog.ts'
import {
  openDatabase,
  SCHEMA_VERSION,
  UnsupportedSchemaError,
} from '../../../src/adapters/storage/sqlite.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

let dir: string
let open: Database[]

beforeEach(() => {
  dir = makeTempDir()
  open = []
})

afterEach(() => {
  for (const db of open) db.close()
  removeTempDir(dir)
})

function connect(): Database {
  const db = openDatabase(join(dir, 'bridge.sqlite'))
  open.push(db)
  return db
}

test('creates the schema, records its version and uses WAL with a busy timeout', () => {
  const db = connect()
  expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
  expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
  expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((t) => t.name)
  expect(tables).toEqual(
    expect.arrayContaining(['allowed_senders', 'audit_log', 'pairings', 'poller_lock']),
  )
})

test('a second connection (another process) opens the same database without re-migrating', () => {
  const first = connect()
  new SqliteAuditLog(first).append({
    at: 1,
    actor: 'terminal',
    event: 'pairing.started',
    details: {},
  })
  const second = connect()
  expect(second.query('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual({ n: 1 })
})

test('refuses a database written by a newer version', () => {
  connect().run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  expect(() => connect()).toThrow(UnsupportedSchemaError)
})

test('the audit log is append-only at the database level', () => {
  const db = connect()
  new SqliteAuditLog(db).append({
    at: 1,
    actor: 'terminal',
    event: 'sender.revoked',
    details: { senderId: '1' },
  })
  expect(() => db.run("UPDATE audit_log SET actor = 'x'")).toThrow('append-only')
  expect(() => db.run('DELETE FROM audit_log')).toThrow('append-only')
  expect(db.query('SELECT actor, event, details FROM audit_log').all()).toEqual([
    { actor: 'terminal', event: 'sender.revoked', details: '{"senderId":"1"}' },
  ])
})

test('allowed sender ids must be decimal strings', () => {
  const db = connect()
  expect(() =>
    db.run("INSERT INTO allowed_senders (id, display_name, added_at) VALUES ('-100', 'x', 0)"),
  ).toThrow()
  expect(() =>
    db.run("INSERT INTO allowed_senders (id, display_name, added_at) VALUES ('12a', 'x', 0)"),
  ).toThrow()
})

test.skipIf(process.platform === 'win32')(
  'the database and its WAL files are owner-only (0600)',
  () => {
    const db = connect()
    new SqliteAuditLog(db).append({
      at: 1,
      actor: 'terminal',
      event: 'pairing.started',
      details: {},
    })
    for (const file of ['bridge.sqlite', 'bridge.sqlite-wal', 'bridge.sqlite-shm']) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
    }
  },
)
