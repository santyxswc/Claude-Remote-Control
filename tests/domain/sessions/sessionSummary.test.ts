import { describe, expect, test } from 'bun:test'
import {
  cleanSummaryText,
  MAX_SUMMARY_BYTES,
  MAX_SUMMARY_SLUG_LENGTH,
  prepareSessionSummary,
  summaryFileName,
  summarySlug,
} from '../../../src/domain/sessions/sessionSummary.ts'

const NOW = Date.UTC(2026, 10, 14, 10, 30, 5)

describe('summarySlug', () => {
  test.each([
    ['Revisión del módulo de pagos', 'revision-del-modulo-de-pagos'],
    ['  F12: /wrap & memory!  ', 'f12-wrap-memory'],
    ['日本語', 'session'],
    ['', 'session'],
    ['../../etc/passwd', 'etc-passwd'],
    ['CON', 'con'],
  ])('%p -> %p', (title, slug) => {
    expect(summarySlug(title)).toBe(slug)
  })

  test('cut at a hyphen, at most 60 characters', () => {
    const slug = summarySlug('word '.repeat(40))
    expect(slug.length).toBeLessThanOrEqual(MAX_SUMMARY_SLUG_LENGTH)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug).toMatch(/^word(-word)*$/)
  })
})

describe('summaryFileName', () => {
  test('UTC stamp without colons, then a numeric suffix on collisions', () => {
    expect(summaryFileName(NOW, 'x')).toBe('2026-11-14T103005Z-x.md')
    expect(summaryFileName(NOW, 'x', 1)).toBe('2026-11-14T103005Z-x-2.md')
    expect(summaryFileName(NOW, 'x', 2)).toBe('2026-11-14T103005Z-x-3.md')
  })
})

describe('prepareSessionSummary', () => {
  test('adds the title as a heading and ends with a newline', () => {
    expect(prepareSessionSummary('Pagos', 'Hecho:\n- a')).toEqual({
      ok: true,
      title: 'Pagos',
      document: '# Pagos\n\nHecho:\n- a\n',
    })
  })

  test('keeps a summary that already starts with a heading', () => {
    const result = prepareSessionSummary('Pagos', '# Otro título\n\ntexto')
    expect(result).toMatchObject({ ok: true, document: '# Otro título\n\ntexto\n' })
  })

  test('strips controls and bidi characters, keeps tabs and newlines, normalizes CRLF', () => {
    expect(cleanSummaryText('a\r\nb\tc\u0007d\u202ee\u200bf')).toBe('a\nb\tcdef')
  })

  test.each([
    ['', 'x', 'empty_title'],
    ['x'.repeat(121), 'x', 'title_too_long'],
    ['t', ' \n\u200b ', 'empty_summary'],
    ['t', 'é'.repeat(MAX_SUMMARY_BYTES / 2), 'too_large'],
  ])('refuses %#', (title, markdown, problem) => {
    expect(prepareSessionSummary(title, markdown)).toEqual({ ok: false, problem } as never)
  })
})
