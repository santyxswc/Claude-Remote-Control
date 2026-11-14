import { expect, test } from 'bun:test'
import { encodeBase64Url } from '../../src/domain/base64url.ts'
import {
  encodePairingCode,
  InsufficientEntropyError,
  isWellFormedPairingCode,
  PAIRING_CODE_LENGTH,
} from '../../src/domain/pairingCode.ts'

test('base64url matches the platform encoder for every length and byte value', () => {
  for (let length = 0; length <= 20; length++) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 97 + length * 31) % 256)
    expect(encodeBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
  }
  const all = Uint8Array.from({ length: 256 }, (_, i) => i)
  expect(encodeBase64Url(all)).toBe(Buffer.from(all).toString('base64url'))
})

test('a pairing code is 16 bytes as 22 base64url characters', () => {
  const code = encodePairingCode(new Uint8Array(16).fill(255))
  expect(code).toHaveLength(PAIRING_CODE_LENGTH)
  expect(code).toBe('_____________________w')
  expect(isWellFormedPairingCode(code)).toBe(true)
})

test('refuses fewer or more than 128 bits', () => {
  expect(() => encodePairingCode(new Uint8Array(15))).toThrow(InsufficientEntropyError)
  expect(() => encodePairingCode(new Uint8Array(17))).toThrow(InsufficientEntropyError)
})

test.each([
  [''],
  ['short'],
  ['a'.repeat(23)],
  ['aaaaaaaaaaaaaaaaaaaaa+'],
  ['aaaaaaaaaaaaaaaaaaaaa='],
])('%p is not a well-formed code', (value) => {
  expect(isWellFormedPairingCode(value)).toBe(false)
})
