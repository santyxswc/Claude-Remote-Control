/** The pinned status message ids (F9): survive a restart, one per chat. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { openState, type StateStores } from '../../../src/adapters/storage/openState.ts'
import {
  DATABASE_FILE,
  openDatabase,
  SCHEMA_VERSION,
} from '../../../src/adapters/storage/sqlite.ts'
import { FakeClock } from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

let dir: string
let state: StateStores

beforeEach(() => {
  dir = makeTempDir()
  state = openState(dir, {}, new FakeClock())
})

afterEach(() => {
  state.db.close()
  removeTempDir(dir)
})

test('put, find, list and remove; one per chat', () => {
  state.statusMessages.put({ chatId: '42', messageId: '7' }, 1)
  state.statusMessages.put({ chatId: '43', messageId: '8' }, 2)
  state.statusMessages.put({ chatId: '42', messageId: '9' }, 3)
  expect(state.statusMessages.find('42')).toEqual({ chatId: '42', messageId: '9' })
  expect(state.statusMessages.list()).toEqual([
    { chatId: '43', messageId: '8' },
    { chatId: '42', messageId: '9' },
  ])
  state.statusMessages.remove('42')
  expect(state.statusMessages.find('42')).toBeUndefined()
  expect(state.statusMessages.list()).toEqual([{ chatId: '43', messageId: '8' }])
})

test('a restart keeps the message id', () => {
  state.statusMessages.put({ chatId: '42', messageId: '7' }, 1)
  state.db.close()
  state = openState(dir, {}, new FakeClock())
  expect(state.statusMessages.find('42')).toEqual({ chatId: '42', messageId: '7' })
})

test('only digit ids are stored', () => {
  for (const ref of [
    { chatId: '-100', messageId: '7' },
    { chatId: '42', messageId: '0' },
    { chatId: 'x', messageId: '7' },
    { chatId: '42', messageId: '7 ' },
  ]) {
    expect(() => state.statusMessages.put(ref, 1)).toThrow()
  }
})

test('migrates a database from before F9', () => {
  state.db.close()
  const path = join(dir, DATABASE_FILE)
  const old = openDatabase(path)
  old.run('DROP TABLE status_messages')
  old.run(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`)
  old.close()
  state = openState(dir, {}, new FakeClock())
  expect(state.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
  state.statusMessages.put({ chatId: '42', messageId: '7' }, 1)
  expect(state.statusMessages.list()).toHaveLength(1)
})
