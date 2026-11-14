import type { RandomSource } from '../../application/ports/RandomSource.ts'

/** The operating system CSPRNG through Web Crypto's `getRandomValues`. */
export class CryptoRandomSource implements RandomSource {
  bytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length))
  }
}
