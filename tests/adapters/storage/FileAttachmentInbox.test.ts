import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileAttachmentInbox } from '../../../src/adapters/storage/FileAttachmentInbox.ts'
import { MemoryLogger } from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

const POSIX = process.platform !== 'win32'
let dir: string
let inbox: FileAttachmentInbox

beforeEach(() => {
  dir = makeTempDir()
  inbox = new FileAttachmentInbox(dir, 'sess_1', new MemoryLogger())
})

afterEach(() => removeTempDir(dir))

test('a kept draft gets our name, private modes and its bytes', async () => {
  const draft = await inbox.draft('pdf')
  await draft.write(new Uint8Array([1, 2]))
  await draft.write(new Uint8Array([3]))
  const path = await draft.keep()
  expect(path).toBe(join(inbox.dir, readdirSync(inbox.dir)[0] ?? ''))
  expect(readdirSync(inbox.dir)[0]).toMatch(/^[0-9a-f]{32}\.pdf$/)
  expect([...readFileSync(path)]).toEqual([1, 2, 3])
  if (POSIX) {
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(inbox.dir).mode & 0o777).toBe(0o700)
  }
  expect((await inbox.list()).map((e) => e.bytes)).toEqual([3])
})

test('a discarded draft leaves nothing; an open draft is invisible to list and remove', async () => {
  const draft = await inbox.draft('txt')
  await draft.write(new Uint8Array([1]))
  const [part] = readdirSync(inbox.dir)
  expect(part).toMatch(/\.part$/)
  expect(await inbox.list()).toEqual([])
  expect(await inbox.remove([part ?? ''])).toBe(0)
  await draft.discard()
  expect(readdirSync(inbox.dir)).toEqual([])
})

test('remove only takes names we create', async () => {
  const outside = join(dir, 'keep.txt')
  writeFileSync(outside, 'x')
  const draft = await inbox.draft('txt')
  await draft.write(new Uint8Array([1]))
  const path = await draft.keep()
  const name = readdirSync(inbox.dir)[0] ?? ''
  expect(await inbox.remove(['../keep.txt', '..', outside, 'x.txt'])).toBe(0)
  expect(existsSync(outside)).toBe(true)
  expect(await inbox.remove([name])).toBe(1)
  expect(existsSync(path)).toBe(false)
})

test('removeOtherSessions removes other inboxes only', async () => {
  const draft = await inbox.draft('txt')
  await draft.write(new Uint8Array([1]))
  await draft.keep()
  mkdirSync(join(dir, 'inbox', 'old'), { recursive: true })
  writeFileSync(join(dir, 'inbox', 'old', 'f.txt'), 'x')
  expect(await inbox.removeOtherSessions()).toBe(1)
  expect(readdirSync(join(dir, 'inbox'))).toEqual(['sess_1'])
  expect(await inbox.list()).toHaveLength(1)
})

test('bad session ids and extensions are refused', async () => {
  for (const session of ['../x', '', 'a/b', 'a'.repeat(65)]) {
    expect(() => new FileAttachmentInbox(dir, session, new MemoryLogger())).toThrow()
  }
  for (const extension of ['', '../x', 'PDF', 'a.b', 'x'.repeat(11)]) {
    await expect(inbox.draft(extension)).rejects.toThrow()
  }
})

test('an empty or missing inbox lists nothing', async () => {
  expect(await inbox.list()).toEqual([])
  expect(await inbox.removeOtherSessions()).toBe(0)
})
