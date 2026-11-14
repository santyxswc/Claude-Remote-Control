import { describe, expect, test } from 'bun:test'
import { InvalidChunkLengthError, splitMessage } from '../../src/domain/splitMessage.ts'

describe('splitMessage', () => {
  test('short text is one chunk', () => {
    expect(splitMessage('hello', 4096)).toEqual(['hello'])
  })

  test('exactly the limit is one chunk', () => {
    const text = 'a'.repeat(4096)
    expect(splitMessage(text, 4096)).toEqual([text])
  })

  test('prefers a paragraph boundary', () => {
    const first = 'a'.repeat(30)
    const second = `${'b'.repeat(10)}\n${'c'.repeat(10)} ${'d'.repeat(10)}`
    expect(splitMessage(`${first}\n\n${second}`, 40)).toEqual([first, second])
  })

  test('then a line break', () => {
    const text = `${'a'.repeat(25)} x\n${'b'.repeat(20)}`
    expect(splitMessage(text, 30)).toEqual([`${'a'.repeat(25)} x`, 'b'.repeat(20)])
  })

  test('then a space', () => {
    expect(splitMessage('aaaa bbbb cccc dddd', 10)).toEqual(['aaaa bbbb', 'cccc dddd'])
  })

  test('then a hard cut', () => {
    expect(splitMessage('a'.repeat(25), 10)).toEqual([
      'a'.repeat(10),
      'a'.repeat(10),
      'a'.repeat(5),
    ])
  })

  test('a boundary in the first half is ignored, so no tiny chunk', () => {
    const text = `ab\n\n${'c'.repeat(30)}`
    expect(splitMessage(text, 20).map((c) => c.length)).toEqual([20, 14])
  })

  test('never splits a surrogate pair', () => {
    const emoji = '\u{1F600}' // two UTF-16 code units
    const text = `${'a'.repeat(9)}${emoji}${'b'.repeat(5)}`
    const chunks = splitMessage(text, 10)
    expect(chunks).toEqual(['a'.repeat(9), `${emoji}${'b'.repeat(5)}`])
    expect(chunks.join('')).toBe(text)
  })

  test('every chunk fits and nothing but separators is lost', () => {
    const words = Array.from({ length: 3000 }, (_, i) => `word${i}${i % 50 === 0 ? '\n\n' : ' '}`)
    const text = words.join('')
    const chunks = splitMessage(text, 4096)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096)
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })

  test('whitespace-only chunks are dropped', () => {
    expect(splitMessage('   \n\n  ', 4096)).toEqual([])
  })

  test('rejects a nonsensical limit', () => {
    expect(() => splitMessage('x', 1)).toThrow(InvalidChunkLengthError)
  })
})
