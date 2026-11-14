import { afterEach, beforeEach, expect, test } from 'bun:test'
import { openState, type StateStores } from '../../../src/adapters/storage/openState.ts'
import { MemoryProposal } from '../../../src/domain/memory/MemoryProposal.ts'
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

const open = (id = 'abcdefghij', session = 's', now = 1_000) =>
  MemoryProposal.open({ id, session, chatId: '42', lines: ['a', 'b'], now })

test('round trip, prompt included', () => {
  const proposal = open().withPrompt({ chatId: '42', messageId: '7' })
  state.memoryProposals.put(proposal)
  expect(state.memoryProposals.findById(proposal.id)?.toSnapshot()).toEqual(proposal.toSnapshot())
  expect(state.memoryProposals.findById('zzzzzzzzzz')).toBeUndefined()
})

test('update is a compare-and-set on the revision', () => {
  const proposal = open()
  state.memoryProposals.put(proposal)
  const approved = proposal.approve('111', 2_000)
  expect(state.memoryProposals.update(approved, proposal.revision)).toBe(true)
  expect(state.memoryProposals.update(proposal.reject('111', 2_000), proposal.revision)).toBe(false)
  expect(state.memoryProposals.findById(proposal.id)?.state).toBe('approved')
})

test('the lines stay on disk only while pending', () => {
  const proposal = open()
  state.memoryProposals.put(proposal)
  state.memoryProposals.update(proposal.reject('111', 2_000), proposal.revision)
  const stored = state.memoryProposals.findById(proposal.id)
  expect(stored?.lines).toEqual([])
  expect(stored?.lineCount).toBe(2)
  const raw = state.db.query('SELECT lines FROM memory_proposals').get() as { lines: string }
  expect(raw.lines).toBe('[]')
})

test('listPending returns pending ones of every session, oldest first', () => {
  state.memoryProposals.put(open('bbbbbbbbbb', 'x', 2_000))
  state.memoryProposals.put(open('aaaaaaaaaa', 'y', 1_000))
  const closed = open('cccccccccc', 'x', 500)
  state.memoryProposals.put(closed.cancel(600))
  expect(state.memoryProposals.listPending().map((p) => p.id)).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb'])
})

test('the schema refuses malformed rows', () => {
  expect(() =>
    state.db.run(
      `INSERT INTO memory_proposals (id, session, chat_id, lines, line_count, state, created_at, revision)
       VALUES ('BAD', 's', '1', '[]', 1, 'pending', 0, 0)`,
    ),
  ).toThrow()
  expect(() =>
    state.db.run(
      `INSERT INTO memory_proposals (id, session, chat_id, lines, line_count, state, created_at, revision)
       VALUES ('abcdefghij', 's', '1', '[]', 9, 'pending', 0, 0)`,
    ),
  ).toThrow()
})
