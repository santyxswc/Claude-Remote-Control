import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileTeeSink, parseLogFile } from '../../../src/adapters/logging/FileTeeSink.ts'
import { StderrLogger } from '../../../src/adapters/logging/StderrLogger.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

let dir: string
let primary: string[]
const sink = { write: (chunk: string) => primary.push(chunk) }

beforeEach(() => {
  dir = makeTempDir()
  primary = []
})

afterEach(() => {
  removeTempDir(dir)
})

describe('parseLogFile', () => {
  test('unset or blank means no file', () => {
    expect(parseLogFile(undefined)).toEqual({ kind: 'off' })
    expect(parseLogFile('  ')).toEqual({ kind: 'off' })
  })

  test('an absolute path is used, trimmed', () => {
    const path = join(dir, 'channel.log')
    expect(parseLogFile(` ${path} `)).toEqual({ kind: 'file', path })
  })

  test('a relative path is refused, never resolved against the working directory', () => {
    expect(parseLogFile('channel.log')).toEqual({ kind: 'invalid', reason: 'relative' })
    expect(parseLogFile('./logs/channel.log')).toEqual({ kind: 'invalid', reason: 'relative' })
  })
})

describe('FileTeeSink', () => {
  test('every line goes to the primary sink and to the file', () => {
    const path = join(dir, 'channel.log')
    const logger = new StderrLogger(new FileTeeSink(sink, path))

    logger.info('telegram polling started', { bot: 'demo_bot' })
    logger.warn('slow')

    const expected = [
      'telegram-bridge [info] telegram polling started {"bot":"demo_bot"}\n',
      'telegram-bridge [warn] slow\n',
    ]
    expect(primary).toEqual(expected)
    expect(readFileSync(path, 'utf8')).toBe(expected.join(''))
  })

  test('appends to an existing file', () => {
    const path = join(dir, 'channel.log')
    writeFileSync(path, 'earlier\n')

    new FileTeeSink(sink, path).write('later\n')

    expect(readFileSync(path, 'utf8')).toBe('earlier\nlater\n')
  })

  test.skipIf(process.platform === 'win32')(
    'the file is owner-only, also when it already existed with a wider mode',
    () => {
      const fresh = join(dir, 'fresh.log')
      new FileTeeSink(sink, fresh).write('x\n')
      expect(statSync(fresh).mode & 0o777).toBe(0o600)

      const wide = join(dir, 'wide.log')
      writeFileSync(wide, '')
      chmodSync(wide, 0o644)
      new FileTeeSink(sink, wide).write('x\n')
      expect(statSync(wide).mode & 0o777).toBe(0o600)
    },
  )

  test('a file that cannot be written is reported once and never breaks logging', () => {
    const tee = new FileTeeSink(sink, join(dir, 'missing', 'channel.log'))

    tee.write('one\n')
    tee.write('two\n')

    expect(primary.filter((line) => line.includes('log file disabled'))).toHaveLength(1)
    expect(primary.slice(-2)).toEqual(['one\n', 'two\n'])
  })
})
