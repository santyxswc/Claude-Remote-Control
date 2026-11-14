import { expect, test } from 'bun:test'
import {
  encodePermissionCallback,
  parsePermissionCallback,
} from '../../../src/application/permissions/callbackData.ts'

test.each([
  ['approve', 'p1:abcde:a'],
  ['deny', 'p1:abcde:d'],
  ['confirm', 'p1:abcde:c'],
  ['cancel', 'p1:abcde:x'],
] as const)('%s round-trips as %s, well under 64 bytes', (action, data) => {
  expect(encodePermissionCallback('abcde', action)).toBe(data)
  expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64)
  expect(parsePermissionCallback(data)).toEqual({ requestId: 'abcde', action })
})

test.each([
  [undefined],
  [''],
  ['p1:abcde:z'],
  ['p2:abcde:a'],
  ['p1:abcdl:a'],
  ['p1:ABCDE:a'],
  ['p1:abcde:a '],
  [' p1:abcde:a'],
  ['p1:abcde:a\n'],
  ['p1:abcde:aa'],
  ['p1:abcd:a'],
  ['p1:abcde'],
  ['p1:abcde:constructor'],
  ['yes abcde'],
])('%p is rejected', (data) => {
  expect(parsePermissionCallback(data)).toBeUndefined()
})

test('encoding refuses an id that is not Claude Code shaped', () => {
  expect(() => encodePermissionCallback('a:b:c', 'approve')).toThrow()
})
