import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { SqlitePermissionStore } from '../../../src/adapters/storage/SqlitePermissionStore.ts'
import { openDatabase } from '../../../src/adapters/storage/sqlite.ts'
import { PermissionRequest } from '../../../src/domain/permissions/PermissionRequest.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

let dir: string
let db: Database
let store: SqlitePermissionStore

beforeEach(() => {
  dir = makeTempDir()
  db = openDatabase(join(dir, 'bridge.sqlite'))
  store = new SqlitePermissionStore(db)
})

afterEach(() => {
  db.close()
  removeTempDir(dir)
})

function request(id = 'abcde', createdAt = 1000, session = 's1'): PermissionRequest {
  return PermissionRequest.open({
    id,
    session,
    toolName: 'Bash',
    description: 'Delete the build',
    inputPreview: '{"command":"rm -rf build"}',
    risk: 'high',
    now: createdAt,
  })
}

test('round-trips every field, including the prompt refs', () => {
  const stored = request()
    .withPrompts([{ chatId: '5000000001', messageId: '42' }])
    .approve('5000000001', 1500)
  store.put(stored)
  expect(store.findById('abcde')?.toSnapshot()).toEqual(stored.toSnapshot())
  expect(store.findById('zzzzz')).toBeUndefined()
})

test('update is a compare-and-set on the revision', () => {
  const first = request()
  store.put(first)
  const denied = first.deny('5000000001', 2000)
  expect(store.update(denied, first.revision)).toBe(true)
  // A second writer that read the same revision loses.
  expect(store.update(first.approve('5000000001', 2001), first.revision)).toBe(false)
  expect(store.findById('abcde')?.state).toBe('denied')
})

test('listOpen returns pending and awaiting requests of every session, oldest first', () => {
  store.put(request('bbbbb', 2000, 'other'))
  store.put(request('aaaaa', 1000))
  store.put(request('ccccc', 3000).approve('1', 3001))
  store.put(request('ddddd', 4000).deny('1', 4001))
  expect(store.listOpen().map((r) => [r.id, r.state])).toEqual([
    ['aaaaa', 'pending'],
    ['bbbbb', 'pending'],
    ['ccccc', 'awaiting_confirmation'],
  ])
})

test('a closed request keeps no description or input on disk', () => {
  const first = request()
  store.put(first)
  store.update(first.deny('5000000001', 2000), first.revision)
  const row = db
    .query<{ description: string; input_preview: string; tool_name: string }, []>(
      'SELECT description, input_preview, tool_name FROM permission_requests',
    )
    .get()
  expect(row).toEqual({ description: '', input_preview: '', tool_name: 'Bash' })
})

test('put replaces an earlier row with the same id', () => {
  store.put(request('abcde', 1000, 'old').expire(1))
  store.put(request('abcde', 5000, 'new'))
  expect(store.findById('abcde')?.session).toBe('new')
})

test('the schema refuses ids that are not Claude Code shaped', () => {
  expect(() =>
    db
      .query(
        `INSERT INTO permission_requests (id, session, tool_name, description, input_preview, risk,
           state, created_at, prompts, revision) VALUES ('abcdl', 's', 't', '', '', 'low', 'pending', 0, '[]', 0)`,
      )
      .run(),
  ).toThrow()
})
