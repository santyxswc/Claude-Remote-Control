import { describe, expect, test } from 'bun:test'
import {
  BRAKE_REASON_MAX_LENGTH,
  brakeSource,
  parseBrakeRecord,
  sanitizeBrakeReason,
  serializeBrakeRecord,
} from '../../../src/domain/brake/BrakeRecord.ts'

describe('sanitizeBrakeReason', () => {
  test('one line of plain text; blank is none', () => {
    expect(sanitizeBrakeReason('  wrong\nbranch\t\u001b[31m now  ')).toBe('wrong branch [31m now')
    expect(sanitizeBrakeReason(' \n ')).toBeUndefined()
    expect(sanitizeBrakeReason(undefined)).toBeUndefined()
  })

  test('cut to the maximum, by code points', () => {
    const cut = sanitizeBrakeReason('🛑'.repeat(BRAKE_REASON_MAX_LENGTH + 5)) ?? ''
    expect(Array.from(cut)).toHaveLength(BRAKE_REASON_MAX_LENGTH)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('the flag file format', () => {
  const record = { engagedAt: 1_700_000_000_000, actor: 'telegram:42', reason: 'stop it' }

  test('round-trips', () => {
    expect(serializeBrakeRecord(record)).toBe(
      '{"v":1,"engagedAt":1700000000000,"actor":"telegram:42","reason":"stop it"}\n',
    )
    expect(parseBrakeRecord(serializeBrakeRecord(record))).toEqual(record)
    const bare = { ...record, reason: undefined }
    expect(parseBrakeRecord(serializeBrakeRecord(bare))).toEqual(bare)
  })

  test.each([
    [''],
    ['garbage'],
    ['null'],
    ['[]'],
    ['{"engagedAt":1,"actor":"terminal"}'],
    ['{"v":2,"engagedAt":1,"actor":"terminal"}'],
    ['{"v":1,"engagedAt":"1","actor":"terminal"}'],
    ['{"v":1,"engagedAt":-1,"actor":"terminal"}'],
    ['{"v":1,"engagedAt":1,"actor":""}'],
    ['{"v":1,"engagedAt":1,"actor":"terminal","reason":7}'],
  ])('%p is not a record', (text) => {
    expect(parseBrakeRecord(text)).toBeUndefined()
  })

  test('a reason edited on disk is sanitized again', () => {
    const text = JSON.stringify({ v: 1, engagedAt: 1, actor: 'terminal', reason: 'a\nb' })
    expect(parseBrakeRecord(text)?.reason).toBe('a b')
  })
})

test('brakeSource', () => {
  expect(brakeSource('terminal')).toBe('terminal')
  expect(brakeSource('telegram:42')).toBe('telegram')
  expect(brakeSource('someone')).toBe('unknown')
})
