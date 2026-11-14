/** Cutting untrusted documents only between lines (F8). */
import { describe, expect, test } from 'bun:test'
import { cutAtLineBoundary, keepCompleteLines, utf8Length } from '../../src/domain/lineCut.ts'

describe('utf8Length', () => {
  test('matches the encoder, lone surrogates as the replacement character', () => {
    for (const text of ['', 'abc', 'ñ', '€', '😀', 'a😀b€ñ\n', '\ud800', 'x\udc00y', '\ud83d']) {
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length)
    }
  })
})

describe('cutAtLineBoundary', () => {
  test('a text that fits is kept whole, even without a final newline', () => {
    expect(cutAtLineBoundary('a\nb', 3)).toEqual({ text: 'a\nb', cut: false })
    expect(cutAtLineBoundary('', 0)).toEqual({ text: '', cut: false })
  })

  test('cuts after the last whole line that fits', () => {
    const text = 'one\ntwo\nthree\n'
    expect(cutAtLineBoundary(text, 13)).toEqual({ text: 'one\ntwo\n', cut: true })
    expect(cutAtLineBoundary(text, 8)).toEqual({ text: 'one\ntwo\n', cut: true })
    expect(cutAtLineBoundary(text, 7)).toEqual({ text: 'one\n', cut: true })
    expect(cutAtLineBoundary(text, 14)).toEqual({ text, cut: false })
  })

  test('a first line longer than the cap keeps nothing', () => {
    expect(cutAtLineBoundary('abcdef\nx\n', 3)).toEqual({ text: '', cut: true })
    expect(cutAtLineBoundary('abcdef', 3)).toEqual({ text: '', cut: true })
  })

  test('never splits a line: a secret on a long line is dropped whole', () => {
    const secret = `token=${'s'.repeat(40)}`
    const text = `a\n${secret}\nb\n`
    for (let cap = 2; cap < utf8Length(text); cap++) {
      const { text: kept } = cutAtLineBoundary(text, cap)
      expect(kept === 'a\n' || kept === `a\n${secret}\n`).toBe(true)
      expect(utf8Length(kept)).toBeLessThanOrEqual(cap)
    }
  })

  test('counts bytes, not characters, and never splits a surrogate pair', () => {
    const text = '😀\n€€\n'
    expect(cutAtLineBoundary(text, 5)).toEqual({ text: '😀\n', cut: true })
    expect(cutAtLineBoundary(text, 11)).toEqual({ text: '😀\n', cut: true })
    expect(cutAtLineBoundary(text, 12)).toEqual({ text, cut: false })
  })
})

describe('keepCompleteLines', () => {
  test('drops the partial last line', () => {
    expect(keepCompleteLines('a\nb\npart')).toBe('a\nb\n')
    expect(keepCompleteLines('a\n')).toBe('a\n')
    expect(keepCompleteLines('no newline')).toBe('')
    expect(keepCompleteLines('')).toBe('')
  })
})
