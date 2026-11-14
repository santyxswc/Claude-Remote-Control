/**
 * L4: the first run of two processes (the channel and, say, a second session's
 * channel) must end with one shared hook secret. Real child processes, so the
 * race is between processes, as in production.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_SECRET_FILE, loadOrCreateHookSecret } from '../../../src/adapters/ipc/hookSecret.ts'
import { SequentialRandom } from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

const FIXTURES = join(import.meta.dir, 'fixtures')

let dir: string
beforeEach(() => {
  dir = makeTempDir()
})
afterEach(() => removeTempDir(dir))

async function output(child: Bun.Subprocess<'ignore', 'pipe', 'inherit'>): Promise<string> {
  const [text] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return text.trim()
}

test('two concurrent creators end with the same secret, which is the one on disk', async () => {
  for (let round = 0; round < 5; round++) {
    const roundDir = join(dir, `round-${round}`)
    mkdirSync(roundDir)
    const startAt = String(Date.now() + 400)
    const spawn = () =>
      Bun.spawn([process.execPath, join(FIXTURES, 'createSecret.ts'), roundDir, startAt], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'inherit',
      })
    const [a, b] = await Promise.all([output(spawn()), output(spawn())])
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toBe(a)
    expect(readFileSync(join(roundDir, HOOK_SECRET_FILE), 'utf8').trim()).toBe(a)
  }
}, 30_000)

test('a file created but not yet filled by another process is waited for, not replaced', async () => {
  const file = join(dir, HOOK_SECRET_FILE)
  writeFileSync(file, '') // the other creator's exclusive create, before its write
  const theirs = 'ab'.repeat(32)
  const child = Bun.spawn(
    [process.execPath, join(FIXTURES, 'fillSecretLater.ts'), file, theirs, '150'],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
  )
  const reader = child.stdout.getReader()
  await reader.read() // "ready": the child runs and will fill the file shortly
  const ours = loadOrCreateHookSecret(dir, new SequentialRandom())
  reader.releaseLock()
  await child.exited
  expect(Buffer.from(ours).toString('hex')).toBe(theirs)
  expect(readFileSync(file, 'utf8').trim()).toBe(theirs)
})

test('a malformed file that nobody fills is replaced after the wait', () => {
  writeFileSync(join(dir, HOOK_SECRET_FILE), 'not hex\n')
  const secret = loadOrCreateHookSecret(dir, new SequentialRandom())
  expect(secret).toHaveLength(32)
  expect(readFileSync(join(dir, HOOK_SECRET_FILE), 'utf8').trim()).toBe(
    Buffer.from(secret).toString('hex'),
  )
})
