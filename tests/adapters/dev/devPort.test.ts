import { describe, expect, test } from 'bun:test'
import { devListenerPort, parseDevPort } from '../../../src/adapters/dev/devPort.ts'
import { MemoryLogger } from '../../fakes.ts'

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

describe('devListenerPort (what main.ts starts)', () => {
  test('a malformed value is logged and the channel goes on without the listener', () => {
    const logger = new MemoryLogger()
    expect(devListenerPort({ raw: 'abc', botConfigured: false, logger })).toBeUndefined()
    expect(logger.entries).toMatchObject([
      { level: 'error', message: 'invalid dev port; the dev listener is off' },
    ])
  })

  test('M4: with a bot token configured the listener never starts, and the log says why', () => {
    const logger = new MemoryLogger()
    expect(devListenerPort({ raw: '8788', botConfigured: true, logger })).toBeUndefined()
    expect(logger.entries).toEqual([
      {
        level: 'error',
        message:
          'TELEGRAM_BRIDGE_DEV_PORT is ignored because a bot token is configured; the dev listener is only for setups without telegram',
      },
    ])
  })

  test('unset stays silent; a valid port without a bot is used', () => {
    const logger = new MemoryLogger()
    expect(devListenerPort({ raw: undefined, botConfigured: true, logger })).toBeUndefined()
    expect(devListenerPort({ raw: '0', botConfigured: false, logger })).toBe(0)
    expect(logger.entries).toEqual([])
  })
})
