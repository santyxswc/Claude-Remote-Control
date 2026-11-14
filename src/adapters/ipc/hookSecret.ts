import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RandomSource } from '../../application/ports/RandomSource.ts'
import { writeSecretFile } from '../storage/stateDir.ts'

/** Shared by the channel and the hook entrypoint: 32 random bytes, hex, 0600. */
export const HOOK_SECRET_FILE = 'hooks.key'

const SECRET_BYTES = 32
const HEX_SECRET = /^[0-9a-f]{64}$/

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

/** The stored secret, created on first use. The state directory must exist. */
export function loadOrCreateHookSecret(stateDir: string, random: RandomSource): Uint8Array {
  const existing = readHookSecret(stateDir)
  if (existing !== undefined) return existing
  const secret = random.bytes(SECRET_BYTES)
  writeSecretFile(join(stateDir, HOOK_SECRET_FILE), `${Buffer.from(secret).toString('hex')}\n`)
  return secret
}
