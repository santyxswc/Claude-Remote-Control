import { describe, expect, test } from 'bun:test'
import { appendSessionNotes } from '../../../src/domain/memory/sessionNotes.ts'

describe('appendSessionNotes', () => {
  test('a new file gets the heading and the bullets', () => {
    expect(appendSessionNotes('', ['a', 'b'])).toBe('## Session notes\n\n- a\n- b\n')
  })

  test('the heading is added once, at the end, keeping everything before it', () => {
    const existing = '# Project\n\nRules.\n'
    expect(appendSessionNotes(existing, ['a'])).toBe(
      '# Project\n\nRules.\n\n## Session notes\n\n- a\n',
    )
  })

  test('a file without a final newline gets one first', () => {
    expect(appendSessionNotes('# P', ['a'])).toBe('# P\n\n## Session notes\n\n- a\n')
  })

  test('bullets join an existing section, before the next heading', () => {
    const existing = '# P\n\n## Session notes\n\n- old\n\n## Other\n\ntext\n'
    expect(appendSessionNotes(existing, ['new'])).toBe(
      '# P\n\n## Session notes\n\n- old\n- new\n\n## Other\n\ntext\n',
    )
  })

  test('appending twice keeps a single heading', () => {
    const once = appendSessionNotes('# P\n', ['a'])
    const twice = appendSessionNotes(once, ['b'])
    expect(twice.match(/## Session notes/g)).toHaveLength(1)
    expect(twice.endsWith('- a\n- b\n')).toBe(true)
  })

  test('a level-three heading stays inside the section', () => {
    const existing = '## Session notes\n\n- a\n\n### Detail\n\nx\n'
    expect(appendSessionNotes(existing, ['b'])).toBe(
      '## Session notes\n\n- a\n\n### Detail\n\nx\n- b\n',
    )
  })

  test('a heading inside a code fence does not count', () => {
    const existing = '# P\n\n```md\n## Session notes\n```\n'
    const result = appendSessionNotes(existing, ['a'])
    expect(result.startsWith(existing)).toBe(true)
    expect(result.endsWith('\n## Session notes\n\n- a\n')).toBe(true)
  })

  test('CRLF files stay CRLF', () => {
    const existing = '# P\r\n\r\nRules.\r\n'
    expect(appendSessionNotes(existing, ['a', 'b'])).toBe(
      '# P\r\n\r\nRules.\r\n\r\n## Session notes\r\n\r\n- a\r\n- b\r\n',
    )
  })

  test('a byte-order mark is kept and does not hide the heading', () => {
    const existing = '\ufeff## Session notes\n\n- a\n'
    expect(appendSessionNotes(existing, ['b'])).toBe('\ufeff## Session notes\n\n- a\n- b\n')
  })
})
