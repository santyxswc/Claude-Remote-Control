import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { RandomSource } from '../../application/ports/RandomSource.ts'
import { SECRET_FILE_MODE, writeSecretFile } from '../storage/stateDir.ts'

/** Shared by the channel and the hook entrypoint: 32 random bytes, hex, 0600. */
export const HOOK_SECRET_FILE = 'hooks.key'

const SECRET_BYTES = 32
const HEX_SECRET = /^[0-9a-f]{64}$/

/**
 * How long to wait for another process that created the file but has not
 * written it yet. Its write follows its create at once, so this is generous.
 */
const CONCURRENT_WRITER_WAIT_MS = 1_000
const RETRY_EVERY_MS = 10

/** The stored secret, or undefined when it is missing or malformed. Never creates it. */
export function readHookSecret(stateDir: string): Uint8Array | undefined {
  let text: string
  try {
    text = readFileSync(join(stateDir, HOOK_SECRET_FILE), 'utf8').trim()
  } catch {
    return undefined
  }
  return HEX_SECRET.test(text) ? Buffer.from(text, 'hex') : undefined
}

/**
 * The stored secret, created on first use. The state directory must exist.
 *
 * Two channel processes may start together on a fresh install. The file is
 * created with exclusive-create semantics (`wx`), so exactly one of them
 * creates it; the other finds it and uses what is in it. The loser may open
 * the file between the winner's create and its write, so an empty or partial
 * file is read again for a short while before it is treated as broken. Only
 * a file that stays malformed (left by a crash, or edited by hand) is
 * replaced, atomically.
 */
export function loadOrCreateHookSecret(stateDir: string, random: RandomSource): Uint8Array {
  const path = join(stateDir, HOOK_SECRET_FILE)
  const existing = readHookSecret(stateDir)
  if (existing !== undefined) return existing

  const secret = random.bytes(SECRET_BYTES)
  const content = `${Buffer.from(secret).toString('hex')}\n`
  if (createExclusively(path, content)) return secret

  // Someone else created it: wait for their write.
  const theirs = waitForSecret(stateDir)
  if (theirs !== undefined) return theirs

  writeSecretFile(path, content)
  // If another process replaced it at the same moment, use whichever landed.
  return readHookSecret(stateDir) ?? secret
}

/** False when the file already exists; any other error is thrown. */
function createExclusively(path: string, content: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', SECRET_FILE_MODE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, SECRET_FILE_MODE)
  return true
}

function waitForSecret(stateDir: string): Uint8Array | undefined {
  const deadline = Date.now() + CONCURRENT_WRITER_WAIT_MS
  for (;;) {
    const secret = readHookSecret(stateDir)
    if (secret !== undefined || Date.now() >= deadline) return secret
    sleepSync(RETRY_EVERY_MS)
  }
}

/** This runs once at listener start-up, so blocking for a few milliseconds is fine. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
