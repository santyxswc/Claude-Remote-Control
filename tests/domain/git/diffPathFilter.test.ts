/** The `/diff [path]` argument policy (F8): hostile shapes never reach git. */
import { describe, expect, test } from 'bun:test'
import {
  type DiffPathProblem,
  MAX_DIFF_PATH_LENGTH,
  parseDiffPathFilter,
} from '../../../src/domain/git/diffPathFilter.ts'

function problem(raw: string): DiffPathProblem | undefined {
  const result = parseDiffPathFilter(raw)
  return result.ok ? undefined : result.problem
}

describe('parseDiffPathFilter', () => {
  test('relative paths pass, normalized to forward slashes', () => {
    expect(parseDiffPathFilter('src')).toEqual({ ok: true, path: 'src' })
    expect(parseDiffPathFilter('src/app.ts')).toEqual({ ok: true, path: 'src/app.ts' })
    expect(parseDiffPathFilter('src\\app.ts')).toEqual({ ok: true, path: 'src/app.ts' })
    expect(parseDiffPathFilter('./src//a/./b/')).toEqual({ ok: true, path: 'src/a/b' })
    expect(parseDiffPathFilter('.')).toEqual({ ok: true, path: '.' })
    expect(parseDiffPathFilter('./')).toEqual({ ok: true, path: '.' })
    expect(parseDiffPathFilter('a file with spaces.md')).toEqual({
      ok: true,
      path: 'a file with spaces.md',
    })
    expect(parseDiffPathFilter('docs/ñandú.md')).toEqual({ ok: true, path: 'docs/ñandú.md' })
    // A `-` or `:` that is not leading is just a character.
    expect(parseDiffPathFilter('src/-x')).toEqual({ ok: true, path: 'src/-x' })
    expect(parseDiffPathFilter('notes:v2')).toEqual({ ok: true, path: 'notes:v2' })
    expect(parseDiffPathFilter('..hidden')).toEqual({ ok: true, path: '..hidden' })
    expect(parseDiffPathFilter('a/b..c')).toEqual({ ok: true, path: 'a/b..c' })
  })

  test('empty and too long', () => {
    expect(problem('')).toBe('empty')
    expect(problem('a'.repeat(MAX_DIFF_PATH_LENGTH))).toBeUndefined()
    expect(problem('a'.repeat(MAX_DIFF_PATH_LENGTH + 1))).toBe('too_long')
  })

  test('absolute, drive and UNC paths', () => {
    for (const raw of [
      '/etc/passwd',
      '\\Windows',
      'C:\\Users',
      'c:/x',
      'C:x',
      '\\\\server\\share',
      '//server/share',
    ]) {
      expect(problem(raw)).toBe('absolute')
    }
  })

  test('any `..` segment', () => {
    for (const raw of ['..', '../x', 'a/../../x', 'a/..', 'a\\..\\..\\x', './..', 'a//../b']) {
      expect(problem(raw)).toBe('traversal')
    }
  })

  test('options, also after normalization', () => {
    for (const raw of ['-p', '--output=/tmp/x', '--', '-', './-p', './/--exec=x', '.\\-x']) {
      expect(problem(raw)).toBe('option')
    }
  })

  test('pathspec magic, also after normalization', () => {
    for (const raw of [
      ':(glob)**',
      ':(top)x',
      ':!src',
      ':^src',
      ':/',
      ':/x',
      './:(exclude)x',
      ':',
    ]) {
      expect(problem(raw)).toBe('magic')
    }
  })

  test('control, separator and bidi characters', () => {
    for (const raw of [
      'a\u0000b',
      'a\nb',
      'a\rb',
      'a\tb',
      '\u001b[31mred',
      'a\u007fb',
      'a\u0085b',
      'a\u2028b',
      'a\u2029b',
      'evil\u202etxt.exe',
      'a\u2066b',
      'a\u2069b',
    ]) {
      expect(problem(raw)).toBe('control')
    }
  })

  test('controls are found before anything else can mask them', () => {
    expect(problem('-\u0000')).toBe('control')
    expect(problem('/\n')).toBe('control')
  })
})
