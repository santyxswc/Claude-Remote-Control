import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DotEnvProjectSecrets,
  parseEnvValues,
} from '../../../src/adapters/system/DotEnvProjectSecrets.ts'
import { MemoryLogger } from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

describe('parseEnvValues', () => {
  test('reads unquoted, quoted, exported and multi-line values', () => {
    const content = [
      '# a comment',
      'PLAIN=plain-Value-1 # trailing comment',
      'export EXPORTED=exp0rted-Value',
      "SINGLE='single # not a comment'",
      'DOUBLE="double\\nescaped"',
      'MULTI="-----BEGIN PRIVATE KEY-----',
      'abc',
      '-----END PRIVATE KEY-----"',
      'EMPTY=',
      'not an assignment',
      'WINDOWS=crlf-Value-2\r',
    ].join('\n')
    expect(parseEnvValues(content)).toEqual([
      'plain-Value-1',
      'exp0rted-Value',
      'single # not a comment',
      'double\\nescaped',
      'double\nescaped',
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      'crlf-Value-2',
    ])
  })

  test('an unterminated quote takes the rest of the file', () => {
    expect(parseEnvValues('A="open\nstill')).toEqual(['open\nstill'])
  })
})

describe('DotEnvProjectSecrets', () => {
  let dir: string
  let other: string

  beforeEach(() => {
    dir = makeTempDir()
    other = makeTempDir()
  })

  afterEach(() => {
    removeTempDir(dir)
    removeTempDir(other)
  })

  test('reads .env and .env.* but not templates or directories', () => {
    writeFileSync(join(dir, '.env'), 'A=from-dotenv-1\n')
    writeFileSync(join(dir, '.env.local'), 'B=from-local-2\n')
    writeFileSync(join(dir, '.env.example'), 'C=placeholder-3\n')
    writeFileSync(join(dir, 'env.txt'), 'D=not-an-env-file-4\n')
    mkdirSync(join(dir, '.env.d'))
    writeFileSync(join(other, '.env.production'), 'E=from-other-5\n')
    const logger = new MemoryLogger()

    const values = new DotEnvProjectSecrets([dir, other, dir], logger).load()

    expect([...values].sort()).toEqual(['from-dotenv-1', 'from-local-2', 'from-other-5'])
    expect(logger.text).not.toContain('from-')
  })

  test('a missing directory yields nothing', () => {
    expect(new DotEnvProjectSecrets([join(dir, 'nope')], new MemoryLogger()).load()).toEqual([])
  })
})
