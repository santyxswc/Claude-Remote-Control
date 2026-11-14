/** A cryptographically secure source of random bytes. */
export interface RandomSource {
  bytes(length: number): Uint8Array
}
