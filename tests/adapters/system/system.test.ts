import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { CryptoRandomSource } from '../../../src/adapters/system/CryptoRandomSource.ts'
import { isProcessAlive } from '../../../src/adapters/system/processAlive.ts'
import { Sha256SecretHasher } from '../../../src/adapters/system/Sha256SecretHasher.ts'
import { SystemClock } from '../../../src/adapters/system/SystemClock.ts'

test('Sha256SecretHasher stores a SHA-256 hex digest, never the secret', () => {
  const hasher = new Sha256SecretHasher()
  const hash = hasher.hash('code-123')
  expect(hash).toBe(createHash('sha256').update('code-123').digest('hex'))
  expect(hash).not.toContain('code-123')
})

test('Sha256SecretHasher matches only the same secret, and survives malformed hashes', () => {
  const hasher = new Sha256SecretHasher()
  const hash = hasher.hash('code-123')
  expect(hasher.matches('code-123', hash)).toBe(true)
  expect(hasher.matches('code-124', hash)).toBe(false)
  expect(hasher.matches('', hash)).toBe(false)
  expect(hasher.matches('code-123', 'abc')).toBe(false)
  expect(hasher.matches('code-123', '')).toBe(false)
})

test('CryptoRandomSource returns the requested number of varying bytes', () => {
  const random = new CryptoRandomSource()
  const a = random.bytes(16)
  const b = random.bytes(16)
  expect(a).toHaveLength(16)
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
})

test('SystemClock reads the wall clock', () => {
  const before = Date.now()
  const now = new SystemClock().now()
  expect(now).toBeGreaterThanOrEqual(before)
  expect(now).toBeLessThanOrEqual(Date.now())
})

test('isProcessAlive knows this process and rejects dead or invalid pids', async () => {
  expect(isProcessAlive(process.pid)).toBe(true)
  expect(isProcessAlive(0)).toBe(false)
  expect(isProcessAlive(-1)).toBe(false)
  expect(isProcessAlive(1.5)).toBe(false)

  const child = Bun.spawn([process.execPath, '-e', '0'])
  await child.exited
  expect(isProcessAlive(child.pid)).toBe(false)
})
