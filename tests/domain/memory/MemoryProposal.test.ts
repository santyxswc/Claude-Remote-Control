import { describe, expect, test } from 'bun:test'
import {
  checkMemoryLines,
  InvalidMemoryTransitionError,
  MAX_MEMORY_LINE_LENGTH,
  MEMORY_PROPOSAL_TTL_MS,
  MemoryProposal,
} from '../../../src/domain/memory/MemoryProposal.ts'

const open = (lines = ['Use bun, not npm']) =>
  MemoryProposal.open({ id: 'abcdefghij', session: 's', chatId: '42', lines, now: 1_000 })

describe('checkMemoryLines', () => {
  test('trims and accepts single lines', () => {
    expect(checkMemoryLines(['  a  ', 'b'])).toEqual({ ok: true, lines: ['a', 'b'] })
  })

  test('accepts exactly 300 code points, astral included', () => {
    expect(checkMemoryLines(['😀'.repeat(MAX_MEMORY_LINE_LENGTH)]).ok).toBe(true)
  })

  test.each([
    [[], 'no_lines', undefined],
    [Array.from({ length: 9 }, () => 'x'), 'too_many_lines', undefined],
    [['a', '   '], 'empty_line', 2],
    [['x'.repeat(301)], 'line_too_long', 1],
    [['a\nb'], 'control_characters', 1],
    [['a\rb'], 'control_characters', 1],
    [['a\tb'], 'control_characters', 1],
    [['a\u2028b'], 'control_characters', 1],
    [['a\u0085b'], 'control_characters', 1],
    [['a\u202eb'], 'invisible_characters', 1],
    [['a\u200bb'], 'invisible_characters', 1],
    [['use ``` fences'], 'code_fence', 1],
    [['~~~'], 'code_fence', 1],
    [['<!-- hidden -->'], 'html_comment', 1],
  ])('%j -> %s', (lines, problem, line) => {
    const result = checkMemoryLines(lines)
    expect(result).toMatchObject({ ok: false, problem })
    if (!result.ok) expect(result.line).toBe(line)
  })
})

describe('MemoryProposal', () => {
  test('opens pending with checked lines only', () => {
    const proposal = open()
    expect(proposal.state).toBe('pending')
    expect(proposal.lineCount).toBe(1)
    expect(() => open(['a\nb'])).toThrow()
    expect(() => open([' untrimmed'])).toThrow()
  })

  test('approve, then a failed write reopens it', () => {
    const approved = open().approve('111', 2_000)
    expect(approved).toMatchObject({ state: 'approved', resolvedBy: '111', closedAt: 2_000 })
    const reopened = approved.writeFailed()
    expect(reopened.state).toBe('pending')
    expect(reopened.revision).toBe(approved.revision + 1)
  })

  test('one answer only', () => {
    const rejected = open().reject('111', 2_000)
    expect(() => rejected.approve('111', 3_000)).toThrow(InvalidMemoryTransitionError)
    expect(() => rejected.expire(3_000)).toThrow(InvalidMemoryTransitionError)
    expect(() => open().writeFailed()).toThrow(InvalidMemoryTransitionError)
  })

  test('due after the TTL, only while pending', () => {
    const proposal = open()
    expect(proposal.isDue(1_000 + MEMORY_PROPOSAL_TTL_MS - 1)).toBe(false)
    expect(proposal.isDue(1_000 + MEMORY_PROPOSAL_TTL_MS)).toBe(true)
    expect(proposal.cancel(2_000).isDue(Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  test('remembering the prompt bumps the revision but not the state', () => {
    const shown = open().withPrompt({ chatId: '42', messageId: '7' })
    expect(shown).toMatchObject({ state: 'pending', revision: 1 })
    expect(shown.prompt).toEqual({ chatId: '42', messageId: '7' })
  })
})
