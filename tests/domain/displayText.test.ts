import { describe, expect, test } from 'bun:test'
import {
  MAX_DISPLAY_TEXT_LENGTH,
  sanitizeDisplayText,
  sanitizeUsername,
} from '../../src/domain/displayText.ts'

describe('sanitizeDisplayText', () => {
  test.each([
    ['ESC and other C0 controls', 'x\u001b[2K\u001b[1A\u0007y', 'x [2K [1A y'],
    ['C1 controls (CSI)', 'a\u009b2Kb\u0085c', 'a 2Kb c'],
    ['DEL', 'a\u007fb', 'a b'],
    ['bidi embeddings and overrides', '\u{202a}a\u{202b}b\u{202c}c\u{202d}d\u{202e}e', 'abcde'],
    ['bidi isolates', '\u{2066}a\u{2067}b\u{2068}c\u{2069}', 'abc'],
    ['directional marks and the Arabic letter mark', 'a\u{200e}b\u{200f}c\u{61c}d', 'abcd'],
    [
      'zero-width characters and the BOM',
      'a\u{200b}b\u{200c}c\u{200d}d\u{2060}e\u{feff}f',
      'abcdef',
    ],
    ['line and paragraph separators', 'a\u{2028}b\u{2029}c', 'a b c'],
    ['newlines and tabs', 'line one\nline two\r\n\tthree', 'line one line two three'],
    ['runs of whitespace', '  Alice    A  ', 'Alice A'],
  ])('removes %s', (_what, raw, expected) => {
    expect(sanitizeDisplayText(raw)).toBe(expected)
  })

  test('keeps ordinary names, accents and emoji intact', () => {
    expect(sanitizeDisplayText('José Ñandú 😀 李')).toBe('José Ñandú 😀 李')
  })

  test('caps the length by code points, never splitting a surrogate pair', () => {
    const long = '😀'.repeat(MAX_DISPLAY_TEXT_LENGTH + 10)
    const out = sanitizeDisplayText(long)
    expect([...out]).toHaveLength(MAX_DISPLAY_TEXT_LENGTH)
    expect(out.endsWith('…')).toBe(true)
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false)
    expect(sanitizeDisplayText('abcdef', 4)).toBe('abc…')
  })

  test('the auditor case: a reversed id cannot be smuggled in', () => {
    const out = sanitizeDisplayText('Santiago (@santi_real), id 12345678 \u{202e}999 di ,')
    expect(out).not.toContain('\u{202e}')
  })
})

describe('sanitizeUsername', () => {
  test.each([
    ['alice_01', 'alice_01'],
    [undefined, undefined],
    ['', undefined],
    ['ali\u{202e}ce', undefined],
    ['alice bob', undefined],
    ['a'.repeat(33), undefined],
  ])('%p -> %p', (raw, expected) => {
    expect(sanitizeUsername(raw)).toBe(expected)
  })
})
