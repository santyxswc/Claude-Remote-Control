import { expect, test } from 'bun:test'
import { ELLIPSIS, elideMiddle } from '../../src/domain/elideMiddle.ts'

test('short text is returned unchanged', () => {
  expect(elideMiddle('hello', 5)).toBe('hello')
})

test('long text keeps its start and its end around an ellipsis', () => {
  const out = elideMiddle('0123456789', 7)
  expect(out).toBe(`012${ELLIPSIS}789`)
  expect(out.length).toBe(7)
})

test('the end of a long command survives', () => {
  const command = `echo ${'x'.repeat(5000)} && rm -rf /`
  const out = elideMiddle(command, 100)
  expect(out.length).toBeLessThanOrEqual(100)
  expect(out.endsWith('&& rm -rf /')).toBe(true)
  expect(out.startsWith('echo ')).toBe(true)
})

test('never splits a surrogate pair', () => {
  const text = '😀'.repeat(20)
  for (let max = 2; max < 40; max++) {
    const out = elideMiddle(text, max)
    expect(out.length).toBeLessThanOrEqual(max)
    expect(out.replaceAll(ELLIPSIS, '').replaceAll('😀', '')).toBe('')
  }
})

test('degenerate limits', () => {
  expect(elideMiddle('abc', 1)).toBe(ELLIPSIS)
  expect(elideMiddle('abc', 0)).toBe('')
})
