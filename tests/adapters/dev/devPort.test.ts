import { expect, test } from 'bun:test'
import { parseDevPort } from '../../../src/adapters/dev/devPort.ts'

test.each([[undefined], [''], ['   ']])('%p disables the dev listener', (raw) => {
  expect(parseDevPort(raw)).toBeUndefined()
})

test.each([
  ['0', 0],
  ['8788', 8788],
  [' 8788 ', 8788],
  ['65535', 65535],
])('%p is port %p', (raw, port) => {
  expect(parseDevPort(raw)).toBe(port)
})

test.each([['abc'], ['-1'], ['80.5'], ['65536'], ['8788x'], ['0x50']])('%p is rejected', (raw) => {
  expect(() => parseDevPort(raw)).toThrow('TELEGRAM_BRIDGE_DEV_PORT must be an integer')
})
