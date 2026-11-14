import { expect, test } from 'bun:test'
import { allowSender } from '../../src/domain/AllowedSender.ts'
import { InvalidSenderIdError, isSenderId, parseSenderId } from '../../src/domain/Sender.ts'
import { MALLORY } from '../fakes.ts'

test('ids beyond 2^53 stay exact because they are strings', () => {
  expect(parseSenderId(' 9007199254740993 ')).toBe('9007199254740993')
  expect(isSenderId(MALLORY.id)).toBe(true)
})

test.each([[''], ['0'], ['-5'], ['12a'], ['1.5'], ['123456789012345678901'], ['@alice']])(
  'rejects %p as a sender id',
  (raw) => {
    expect(isSenderId(raw.trim())).toBe(false)
    expect(() => parseSenderId(raw)).toThrow(InvalidSenderIdError)
  },
)

test('allowSender stamps the time', () => {
  expect(allowSender(MALLORY, 42)).toEqual({ ...MALLORY, addedAt: 42 })
})
