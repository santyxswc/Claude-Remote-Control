import { expect, test } from 'bun:test'
import { StderrLogger } from '../../../src/adapters/logging/StderrLogger.ts'

function capture() {
  const lines: string[] = []
  return { lines, logger: new StderrLogger({ write: (chunk: string) => lines.push(chunk) }) }
}

test('writes one prefixed line per entry', () => {
  const { lines, logger } = capture()

  logger.info('started')
  logger.warn('slow', { ms: 1200 })

  expect(lines).toEqual([
    'telegram-bridge [info] started\n',
    'telegram-bridge [warn] slow {"ms":1200}\n',
  ])
})

test('serializes errors by name and message', () => {
  const { lines, logger } = capture()

  logger.error('failed', { error: new TypeError('boom') })

  expect(lines).toEqual([
    'telegram-bridge [error] failed {"error":{"name":"TypeError","message":"boom"}}\n',
  ])
})
