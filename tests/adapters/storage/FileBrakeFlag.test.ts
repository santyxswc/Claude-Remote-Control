import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRAKE_FILE,
  brakeFilePath,
  readBrakeFile,
} from '../../../src/adapters/storage/brakeFile.ts'
import { FileBrakeFlag } from '../../../src/adapters/storage/FileBrakeFlag.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

const RECORD = { engagedAt: 1_700_000_000_000, actor: 'telegram:42', reason: 'wrong branch' }

let dir: string
beforeEach(() => {
  dir = makeTempDir()
})
afterEach(() => removeTempDir(dir))

describe('FileBrakeFlag', () => {
  test('absent until engaged; engage, status, release, release again', () => {
    const flag = new FileBrakeFlag(dir)
    expect(flag.status()).toEqual({ engaged: false })
    flag.engage(RECORD)
    expect(flag.status()).toEqual({ engaged: true, record: RECORD })
    expect(flag.release()).toBe(true)
    expect(flag.status()).toEqual({ engaged: false })
    expect(flag.release()).toBe(false)
  })

  test('writes atomically: replaces the old flag and leaves no temp file behind', () => {
    const flag = new FileBrakeFlag(dir)
    flag.engage(RECORD)
    flag.engage({ ...RECORD, actor: 'terminal', reason: undefined })
    expect(readdirSync(dir)).toEqual([BRAKE_FILE])
    expect(JSON.parse(readFileSync(join(dir, BRAKE_FILE), 'utf8'))).toEqual({
      v: 1,
      engagedAt: RECORD.engagedAt,
      actor: 'terminal',
    })
  })

  test.skipIf(process.platform === 'win32')('the flag file is 0600', () => {
    new FileBrakeFlag(dir).engage(RECORD)
    expect(statSync(join(dir, BRAKE_FILE)).mode & 0o777).toBe(0o600)
  })

  test('a corrupt or oversized flag counts as engaged, with no record', () => {
    const flag = new FileBrakeFlag(dir)
    writeFileSync(join(dir, BRAKE_FILE), 'not json')
    expect(flag.status()).toEqual({ engaged: true, record: undefined })
    writeFileSync(join(dir, BRAKE_FILE), '')
    expect(flag.status()).toEqual({ engaged: true, record: undefined })
    writeFileSync(
      join(dir, BRAKE_FILE),
      `{"v":1,"engagedAt":1,"actor":"x","pad":"${'x'.repeat(5000)}"}`,
    )
    expect(flag.status()).toEqual({ engaged: true, record: undefined })
    expect(flag.release()).toBe(true)
    expect(flag.status()).toEqual({ engaged: false })
  })
})

describe('readBrakeFile', () => {
  test('a missing state directory is not braked (fail open)', () => {
    expect(readBrakeFile(join(dir, 'never-created'))).toEqual({ kind: 'absent' })
    writeFileSync(join(dir, 'a-file'), '')
    expect(readBrakeFile(join(dir, 'a-file'))).toEqual({ kind: 'absent' })
  })

  test('a flag path that cannot be read (a directory) is braked (fail closed)', () => {
    mkdirSync(brakeFilePath(dir))
    expect(readBrakeFile(dir)).toEqual({ kind: 'unreadable' })
  })
})
