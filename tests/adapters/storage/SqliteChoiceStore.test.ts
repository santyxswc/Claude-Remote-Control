import { afterEach, beforeEach, expect, test } from 'bun:test'
import { openState, type StateStores } from '../../../src/adapters/storage/openState.ts'
import { Choice } from '../../../src/domain/choices/Choice.ts'
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

const choice = (id = 'abcdefghij', now = 1) =>
  Choice.open({
    id,
    session: 's1',
    chatId: '42',
    question: 'Which one?\nReally?',
    options: ['A', 'B'],
    allowOther: true,
    now,
  })

test('round trip of an open choice', () => {
  const open = choice().withPrompt({ chatId: '42', messageId: '7' })
  state.choices.put(open)
  expect(state.choices.findById(open.id)?.toSnapshot()).toEqual(open.toSnapshot())
  expect(state.choices.findById('zzzzzzzzzz')).toBeUndefined()
})

test('compare-and-set on the revision', () => {
  const open = choice()
  state.choices.put(open)
  const answered = open.choose(0, '42', 5)
  expect(state.choices.update(answered, open.revision)).toBe(true)
  expect(state.choices.update(open.chooseOther(), open.revision)).toBe(false)
  expect(state.choices.findById(open.id)?.state).toBe('answered')
})

test('a closed choice keeps ids and the answer, not the question or labels', () => {
  const open = choice()
  state.choices.put(open)
  state.choices.update(open.choose(1, '42', 5), open.revision)
  const row = state.db
    .query<{ question: string; options: string }, []>('SELECT question, options FROM choices')
    .get()
  expect(row).toEqual({ question: '', options: '[]' })
  const stored = state.choices.findById(open.id)
  expect(stored?.answer).toEqual({ kind: 'option', index: 1 })
  expect(stored?.answeredBy).toBe('42')
})

test('listOpen: pending and awaiting_text, oldest first', () => {
  const a = choice('aaaaaaaaaa', 3)
  const b = choice('bbbbbbbbbb', 1).chooseOther()
  const c = choice('cccccccccc', 2).expire(9)
  for (const item of [a, b, c]) state.choices.put(item)
  expect(state.choices.listOpen().map((x) => x.id)).toEqual(['bbbbbbbbbb', 'aaaaaaaaaa'])
})

test('the schema refuses an invalid id or state', () => {
  expect(() =>
    state.db
      .query(
        `INSERT INTO choices (id, session, chat_id, question, options, allow_other, state, created_at, revision)
         VALUES ('bad', 's', '1', 'q', '[]', 0, 'pending', 0, 0)`,
      )
      .run(),
  ).toThrow()
  expect(() =>
    state.db
      .query(
        `INSERT INTO choices (id, session, chat_id, question, options, allow_other, state, created_at, revision)
         VALUES ('abcdefghij', 's', '1', 'q', '[]', 0, 'weird', 0, 0)`,
      )
      .run(),
  ).toThrow()
})
