import { describe, expect, test } from 'bun:test'
import {
  CHOICE_TTL_MS,
  Choice,
  choiceIdFrom,
  InvalidChoiceTransitionError,
  isChoiceId,
  normalizeChoiceOptions,
  normalizeChoiceQuestion,
} from '../../../src/domain/choices/Choice.ts'
import { DomainError } from '../../../src/domain/DomainError.ts'

const NOW = 1_700_000_000_000

function open(allowOther = true): Choice {
  return Choice.open({
    id: 'abcdefghij',
    session: 's1',
    chatId: '42',
    question: 'Which?',
    options: ['A', 'B'],
    allowOther,
    now: NOW,
  })
}

describe('choice ids', () => {
  test('ten base32 characters from ten bytes, without bias', () => {
    const id = choiceIdFrom(new Uint8Array([0, 1, 2, 31, 32, 63, 255, 26, 27, 30, 99]))
    expect(id).toBe('abc7a77236')
    expect(isChoiceId(id)).toBe(true)
  })

  test('too few bytes is an error', () => {
    expect(() => choiceIdFrom(new Uint8Array(9))).toThrow(DomainError)
  })

  test.each(['', 'abcdefghi', 'abcdefghijk', 'ABCDEFGHIJ', 'abcdefgh18', 'abcde:ghij'])(
    'rejects %p',
    (value) => expect(isChoiceId(value)).toBe(false),
  )

  test('open refuses a bad id', () => {
    expect(() =>
      Choice.open({
        id: 'bad',
        session: 's',
        chatId: '1',
        question: 'q',
        options: ['a', 'b'],
        allowOther: false,
        now: 0,
      }),
    ).toThrow(DomainError)
  })
})

describe('normalizing', () => {
  test('the question keeps lines and drops controls and bidi overrides', () => {
    expect(normalizeChoiceQuestion('  Line 1\u{202e}\n\n\n\nLine\u0007 2  ')).toEqual({
      ok: true,
      value: 'Line 1\n\nLine 2',
    })
    expect(normalizeChoiceQuestion(' \u{200b}\n ')).toEqual({
      ok: false,
      problem: 'empty_question',
    })
  })

  test('labels are one line, sanitized, never cut', () => {
    expect(normalizeChoiceOptions(['  Yes\nplease ', 'No\u{202e}'])).toEqual({
      ok: true,
      value: ['Yes please', 'No'],
    })
    expect(normalizeChoiceOptions(['a'.repeat(64), 'b'])).toMatchObject({ ok: true })
    expect(normalizeChoiceOptions(['a'.repeat(65), 'b'])).toEqual({
      ok: false,
      problem: 'option_too_long',
    })
  })

  test('count, empty and duplicate labels are refused', () => {
    expect(normalizeChoiceOptions(['a'])).toEqual({ ok: false, problem: 'too_few_options' })
    expect(normalizeChoiceOptions(Array.from({ length: 9 }, (_, i) => `${i}`))).toEqual({
      ok: false,
      problem: 'too_many_options',
    })
    expect(normalizeChoiceOptions(['a', '\u{200b}'])).toEqual({
      ok: false,
      problem: 'empty_option',
    })
    expect(normalizeChoiceOptions(['Yes', ' yes '])).toEqual({
      ok: false,
      problem: 'duplicate_option',
    })
  })
})

describe('the state machine', () => {
  test('pending -> answered once; the revision counts every change', () => {
    const choice = open()
    expect(choice.state).toBe('pending')
    expect(choice.revision).toBe(0)
    const answered = choice.choose(1, '7', NOW + 5)
    expect(answered.state).toBe('answered')
    expect(answered.chosenLabel).toBe('B')
    expect(answered.answeredBy).toBe('7')
    expect(answered.closedAt).toBe(NOW + 5)
    expect(answered.revision).toBe(1)
    expect(choice.state).toBe('pending')
    expect(() => answered.choose(0, '7', NOW)).toThrow(InvalidChoiceTransitionError)
    expect(() => answered.expire(NOW)).toThrow(InvalidChoiceTransitionError)
  })

  test('a missing option index is refused', () => {
    for (const index of [-1, 2, 0.5, Number.NaN]) {
      expect(() => open().choose(index, '7', NOW)).toThrow(InvalidChoiceTransitionError)
    }
  })

  test('"other" -> awaiting_text -> answered with text', () => {
    const waiting = open().chooseOther()
    expect(waiting.state).toBe('awaiting_text')
    expect(waiting.isOpen).toBe(true)
    expect(() => waiting.choose(0, '7', NOW)).toThrow(InvalidChoiceTransitionError)
    const answered = waiting.answerWithText('7', NOW)
    expect(answered.answer).toEqual({ kind: 'text' })
    expect(answered.chosenLabel).toBeUndefined()
  })

  test('"other" needs allowOther', () => {
    expect(() => open(false).chooseOther()).toThrow(InvalidChoiceTransitionError)
    expect(() => open().answerWithText('7', NOW)).toThrow(InvalidChoiceTransitionError)
  })

  test('expiry after 30 minutes, from pending or awaiting_text', () => {
    expect(open().isDue(NOW + CHOICE_TTL_MS - 1)).toBe(false)
    expect(open().isDue(NOW + CHOICE_TTL_MS)).toBe(true)
    expect(
      open()
        .chooseOther()
        .isDue(NOW + CHOICE_TTL_MS),
    ).toBe(true)
    const expired = open().expire(NOW + CHOICE_TTL_MS)
    expect(expired.state).toBe('expired')
    expect(expired.isDue(NOW + 2 * CHOICE_TTL_MS)).toBe(false)
    expect(() => expired.cancel(NOW)).toThrow(InvalidChoiceTransitionError)
  })

  test('cancel closes an open choice', () => {
    expect(open().cancel(NOW).state).toBe('cancelled')
    expect(open().chooseOther().cancel(NOW).state).toBe('cancelled')
  })

  test('a failed delivery reopens it', () => {
    const reopened = open().choose(0, '7', NOW).deliveryFailed()
    expect(reopened.state).toBe('pending')
    expect(reopened.answer).toBeUndefined()
    expect(reopened.answeredBy).toBeUndefined()
    expect(() => open().deliveryFailed()).toThrow(InvalidChoiceTransitionError)
  })

  test('withPrompt records the message and restore round-trips', () => {
    const choice = open().withPrompt({ chatId: '42', messageId: '9' })
    expect(choice.prompt).toEqual({ chatId: '42', messageId: '9' })
    expect(choice.state).toBe('pending')
    expect(Choice.restore(choice.toSnapshot()).toSnapshot()).toEqual(choice.toSnapshot())
  })
})
