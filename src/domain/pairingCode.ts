import { encodeBase64Url } from './base64url.ts'
import { DomainError } from './DomainError.ts'

/** 128 bits from a cryptographic source. */
export const PAIRING_CODE_BYTES = 16

/** 16 bytes in unpadded base64url; fits Telegram's 64-character `start` parameter. */
export const PAIRING_CODE_LENGTH = 22

const WELL_FORMED = /^[A-Za-z0-9_-]{22}$/

export class InsufficientEntropyError extends DomainError {
  constructor(got: number) {
    super(`A pairing code needs ${PAIRING_CODE_BYTES} random bytes, got ${got}`)
  }
}

export function encodePairingCode(randomBytes: Uint8Array): string {
  if (randomBytes.length !== PAIRING_CODE_BYTES) {
    throw new InsufficientEntropyError(randomBytes.length)
  }
  return encodeBase64Url(randomBytes)
}

export function isWellFormedPairingCode(value: string): boolean {
  return WELL_FORMED.test(value)
}
