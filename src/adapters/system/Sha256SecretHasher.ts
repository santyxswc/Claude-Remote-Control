import { createHash, timingSafeEqual } from 'node:crypto'
import type { SecretHasher } from '../../application/ports/SecretHasher.ts'

/**
 * SHA-256 (hex). A plain hash is enough for a 128-bit random code that lives
 * 120 seconds: there is nothing to brute-force offline.
 */
export class Sha256SecretHasher implements SecretHasher {
  hash(secret: string): string {
    return digest(secret).toString('hex')
  }

  /** Compares fixed-length digests with `timingSafeEqual`, so timing reveals nothing. */
  matches(secret: string, hash: string): boolean {
    const expected = Buffer.from(hash, 'hex')
    const actual = digest(secret)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
}

function digest(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}
