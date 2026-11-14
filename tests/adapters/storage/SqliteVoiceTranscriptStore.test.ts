import { afterEach, beforeEach, expect, test } from 'bun:test'
import { openState, type StateStores } from '../../../src/adapters/storage/openState.ts'
import { VoiceTranscript } from '../../../src/domain/voice/VoiceTranscript.ts'
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

const transcript = (id = 'abcdefghij', now = 1_000) =>
  VoiceTranscript.open({
    id,
    session: 's1',
    chatId: '42',
    text: 'hola mundo',
    durationSeconds: 3,
    now,
  })

test('round trip, compare-and-set, pending listing oldest first', () => {
  const store = state.voiceTranscripts
  const a = transcript('abcdefghij', 2_000)
  const b = transcript('bcdefghijk', 1_000)
  store.put(a)
  store.put(b)
  expect(store.findById(a.id)?.toSnapshot()).toEqual(a.toSnapshot())
  expect(store.listPending().map((t) => t.id)).toEqual([b.id, a.id])

  const withPrompt = a.withPrompt({ chatId: '42', messageId: '77' })
  expect(store.update(withPrompt, a.revision)).toBe(true)
  // A stale revision loses.
  expect(store.update(a.send('1', 3_000), a.revision)).toBe(false)
  expect(store.findById(a.id)?.prompt).toEqual({ chatId: '42', messageId: '77' })
})

test('the text is kept only while pending', () => {
  const store = state.voiceTranscripts
  const t = transcript()
  store.put(t)
  expect(store.update(t.send('1', 2_000), t.revision)).toBe(true)
  const stored = store.findById(t.id)
  expect(stored?.state).toBe('sent')
  expect(stored?.text).toBe('')
  expect(stored?.length).toBe(10)
  const raw = state.db.query('SELECT text FROM voice_transcripts').get() as { text: string }
  expect(raw.text).toBe('')
  expect(store.listPending()).toEqual([])
})

test('the schema refuses bad ids and states', () => {
  expect(() =>
    state.db.run(
      `INSERT INTO voice_transcripts VALUES ('x', 's', '1', 't', 1, 1, 'pending', 0, NULL, NULL, NULL, 0)`,
    ),
  ).toThrow()
  expect(() =>
    state.db.run(
      `INSERT INTO voice_transcripts VALUES ('abcdefghij', 's', '1', 't', 1, 1, 'played', 0, NULL, NULL, NULL, 0)`,
    ),
  ).toThrow()
})
