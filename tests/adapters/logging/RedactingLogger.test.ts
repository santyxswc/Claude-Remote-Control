import { expect, test } from 'bun:test'
import { RedactingLogger } from '../../../src/adapters/logging/RedactingLogger.ts'
import { StderrLogger } from '../../../src/adapters/logging/StderrLogger.ts'
import { MemoryLogger } from '../../fakes.ts'
import { TEST_TOKEN } from '../../fakeTelegram.ts'

test('removes the secret from messages, fields and nested errors', () => {
  const lines: string[] = []
  const logger = new RedactingLogger(new StderrLogger({ write: (c: string) => lines.push(c) }), [
    TEST_TOKEN,
  ])

  logger.info(`token is ${TEST_TOKEN}`)
  logger.warn('w', {
    url: `https://api.telegram.org/bot${TEST_TOKEN}/getMe`,
    nested: { t: TEST_TOKEN },
  })
  logger.error('e', { error: new Error(`failed with ${TEST_TOKEN}`) })

  const output = lines.join('')
  expect(output).not.toContain(TEST_TOKEN)
  expect(lines).toEqual([
    'telegram-bridge [info] token is [redacted]\n',
    'telegram-bridge [warn] w {"url":"https://api.telegram.org/bot[redacted]/getMe","nested":{"t":"[redacted]"}}\n',
    'telegram-bridge [error] e {"error":{"name":"Error","message":"failed with [redacted]"}}\n',
  ])
})

test('passes clean entries through unchanged', () => {
  const inner = new MemoryLogger()
  const fields = { n: 1 }
  new RedactingLogger(inner, [TEST_TOKEN, '']).info('ok', fields)
  expect(inner.entries).toEqual([{ level: 'info', message: 'ok', fields }])
})
