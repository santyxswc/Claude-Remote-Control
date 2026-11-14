import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import {
  FileAudioScratch,
  STALE_WORKSPACE_MS,
  VOICE_SCRATCH_DIR,
} from '../../../src/adapters/voice/FileAudioScratch.ts'
import { VOICE_AUDIO_FILE } from '../../../src/adapters/voice/voiceInvocations.ts'
import { MemoryLogger } from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

let stateDir: string

beforeEach(() => {
  stateDir = makeTempDir()
})

afterEach(() => {
  removeTempDir(stateDir)
})

test('a private directory per note, our own names, removed with everything in it', async () => {
  const scratch = new FileAudioScratch(stateDir, new MemoryLogger())
  const draft = await scratch.create()
  const root = join(stateDir, VOICE_SCRATCH_DIR)
  expect(draft.dir.startsWith(root)).toBe(true)
  expect(readdirSync(root)[0]).toMatch(/^[0-9a-f]{32}$/)
  await draft.write(new Uint8Array([1, 2, 3]))
  await draft.write(new Uint8Array([4]))
  await draft.close()
  const audio = join(draft.dir, VOICE_AUDIO_FILE)
  expect([...readFileSync(audio)]).toEqual([1, 2, 3, 4])
  if (process.platform !== 'win32') {
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(draft.dir).mode & 0o777).toBe(0o700)
    expect(statSync(audio).mode & 0o777).toBe(0o600)
  }
  await scratch.dispose(draft)
  expect(existsSync(draft.dir)).toBe(false)
  expect(readdirSync(root)).toEqual([])
})

test('dispose closes a file still open (an aborted download) and never rejects', async () => {
  const scratch = new FileAudioScratch(stateDir, new MemoryLogger())
  const draft = await scratch.create()
  await draft.write(new Uint8Array([1]))
  await scratch.dispose(draft)
  expect(existsSync(draft.dir)).toBe(false)
  await scratch.dispose(draft)
})

test('the sweep removes only stale workspaces with our names', async () => {
  let now = Date.now()
  const scratch = new FileAudioScratch(stateDir, new MemoryLogger(), () => now)
  const fresh = await scratch.create()
  const stale = await scratch.create()
  await stale.close()
  await fresh.close()
  const old = new Date(Date.now() - STALE_WORKSPACE_MS - 60_000)
  utimesSync(stale.dir, old, old)
  const foreign = join(stateDir, VOICE_SCRATCH_DIR, 'not-ours')
  mkdirSync(foreign)
  utimesSync(foreign, old, old)
  expect(await scratch.sweep()).toBe(1)
  expect(existsSync(stale.dir)).toBe(false)
  expect(existsSync(fresh.dir)).toBe(true)
  expect(existsSync(foreign)).toBe(true)
  now += STALE_WORKSPACE_MS + 60_000
  expect(await scratch.sweep()).toBe(1)
  expect(existsSync(fresh.dir)).toBe(false)
})

test('the sweep of a missing root is nothing', async () => {
  expect(await new FileAudioScratch(stateDir, new MemoryLogger()).sweep()).toBe(0)
})
