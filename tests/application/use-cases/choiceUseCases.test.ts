import { describe, expect, test } from 'bun:test'
import { ChoicePrompts, choiceKeyboard } from '../../../src/application/choices/ChoicePrompts.ts'
import {
  encodeChoiceCallback,
  parseChoiceCallback,
} from '../../../src/application/choices/choiceCallbackData.ts'
import { PromptTooLongError } from '../../../src/application/errors.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import type { ChoiceStore } from '../../../src/application/ports/ChoiceStore.ts'
import type { PromptKeyboard } from '../../../src/application/ports/PromptGateway.ts'
import { AnswerChoice } from '../../../src/application/use-cases/AnswerChoice.ts'
import { AnswerChoiceWithText } from '../../../src/application/use-cases/AnswerChoiceWithText.ts'
import { AskChoice } from '../../../src/application/use-cases/AskChoice.ts'
import { AuthorizeReplyTarget } from '../../../src/application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { ExpireChoices } from '../../../src/application/use-cases/ExpireChoices.ts'
import type { ForwardableMessage } from '../../../src/application/use-cases/HandleInboundMessage.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { CHOICE_TTL_MS, Choice } from '../../../src/domain/choices/Choice.ts'
import type { PromptRef } from '../../../src/domain/permissions/PermissionRequest.ts'
import {
  ALICE,
  FakeChatGateway,
  FakeClock,
  FakePromptGateway,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  InMemoryBrakeFlag,
  MALLORY,
  MemoryLogger,
  SequentialRandom,
} from '../../fakes.ts'

const en = messagesFor('en')

class InMemoryChoiceStore implements ChoiceStore {
  readonly rows = new Map<string, Choice>()
  put(choice: Choice): void {
    this.rows.set(choice.id, choice)
  }
  update(next: Choice, expectedRevision: number): boolean {
    if (this.rows.get(next.id)?.revision !== expectedRevision) return false
    this.rows.set(next.id, next)
    return true
  }
  findById(id: string): Choice | undefined {
    return this.rows.get(id)
  }
  listOpen(): readonly Choice[] {
    return [...this.rows.values()].filter((c) => c.isOpen).sort((a, b) => a.createdAt - b.createdAt)
  }
}

function harness() {
  const clock = new FakeClock()
  const store = new InMemoryChoiceStore()
  const gateway = new FakePromptGateway()
  const chat = new FakeChatGateway()
  const logger = new MemoryLogger()
  const audit = new InMemoryAuditLog()
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, clock.now()))
  const authorize = new AuthorizeSender(allowed)
  const brake = new InMemoryBrakeFlag()
  const prompts = new ChoicePrompts(gateway, chat, en, logger)
  const forwarded: ForwardableMessage[] = []
  let forwardOutcome: 'forwarded' | 'failed' = 'forwarded'
  const forward = {
    execute: async (message: ForwardableMessage) => {
      if (forwardOutcome === 'forwarded') forwarded.push(message)
      return forwardOutcome
    },
  }
  let polling = true
  const common = { store, prompts, audit, clock, logger, session: 'me' }
  const ask = new AskChoice({
    ...common,
    target: new AuthorizeReplyTarget(authorize),
    random: new SequentialRandom(),
    canAsk: () => polling,
  })
  const answer = new AnswerChoice({ ...common, forward, authorize, brake })
  const withText = new AnswerChoiceWithText(common)
  const expire = new ExpireChoices(common)
  return {
    clock,
    store,
    gateway,
    chat,
    logger,
    audit,
    brake,
    forwarded,
    ask,
    answer,
    withText,
    expire,
    prompts,
    setForward: (outcome: 'forwarded' | 'failed') => {
      forwardOutcome = outcome
    },
    stopPolling: () => {
      polling = false
    },
  }
}

const request = (overrides: Partial<Parameters<AskChoice['execute']>[0]> = {}) => ({
  chatId: ALICE.id,
  question: 'Which?',
  options: ['A', 'B'],
  allowOther: true,
  ...overrides,
})

async function askedId(h: ReturnType<typeof harness>, allowOther = true): Promise<string> {
  const outcome = await h.ask.execute(request({ allowOther }))
  if (outcome.status !== 'asked') throw new Error(`not asked: ${outcome.status}`)
  return outcome.choiceId
}

const tapInput = (choiceId: string, pick: number | 'other', sender = ALICE) => ({
  choiceId,
  pick,
  sender,
  chatId: sender.id,
  messageId: '500',
})

describe('choice callback data', () => {
  test('round trip, at most 64 bytes', () => {
    for (const pick of [0, 7, 'other'] as const) {
      const data = encodeChoiceCallback('abcdefghij', pick)
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64)
      expect(parseChoiceCallback(data)).toEqual({ choiceId: 'abcdefghij', pick })
    }
  })

  test.each([
    undefined,
    '',
    'c1:abcdefghij:8',
    'c1:abcdefghij:-1',
    'c1:abcdefghij:01',
    'c1:abcdefghij:other',
    'c1:ABCDEFGHIJ:0',
    'c1:abcdefghi:0',
    'c2:abcdefghij:0',
    ' c1:abcdefghij:0',
    'c1:abcdefghij:0\n',
    'p1:abcde:a',
    'k1:p1',
  ])('rejects %p', (data) => expect(parseChoiceCallback(data)).toBeUndefined())

  test('encoding refuses bad input', () => {
    expect(() => encodeChoiceCallback('bad', 0)).toThrow()
    expect(() => encodeChoiceCallback('abcdefghij', 8)).toThrow()
  })
})

describe('AskChoice', () => {
  test('posts the buttons, stores the prompt and returns at once', async () => {
    const h = harness()
    const id = await askedId(h)
    expect(h.gateway.sent).toHaveLength(1)
    expect(h.gateway.sent[0]?.text).toBe(en.choicePrompt('Which?'))
    expect(h.gateway.sent[0]?.keyboard.flat().map((b) => b.data)).toEqual([
      `c1:${id}:0`,
      `c1:${id}:1`,
      `c1:${id}:o`,
    ])
    expect(h.store.findById(id)?.prompt).toEqual({ chatId: ALICE.id, messageId: '500' })
    expect(h.audit.entries.map((e) => e.event)).toEqual(['choice.asked'])
    expect(JSON.stringify(h.audit.entries)).not.toContain('Which?')
  })

  test('a chat that is not allowlisted is refused and audited', async () => {
    const h = harness()
    expect(await h.ask.execute(request({ chatId: MALLORY.id }))).toEqual({
      status: 'refused',
      reason: 'chat_not_allowed',
    })
    expect(await h.ask.execute(request({ chatId: 'not a chat' }))).toMatchObject({
      status: 'refused',
    })
    expect(h.audit.entries.map(({ details: { chatId } }) => chatId)).toEqual([
      MALLORY.id,
      'invalid',
    ])
    expect(h.gateway.sent).toEqual([])
  })

  test('not polling: refused, nothing posted', async () => {
    const h = harness()
    h.stopPolling()
    expect(await h.ask.execute(request())).toEqual({ status: 'refused', reason: 'not_polling' })
    expect(h.store.rows.size).toBe(0)
  })

  test('invalid options are reported with the problem', async () => {
    const h = harness()
    expect(await h.ask.execute(request({ options: ['a', 'A'] }))).toEqual({
      status: 'invalid',
      problem: 'duplicate_option',
    })
    expect(await h.ask.execute(request({ question: '\u{200b}' }))).toEqual({
      status: 'invalid',
      problem: 'empty_question',
    })
  })

  test('a failed send cancels the stored choice', async () => {
    const h = harness()
    h.gateway.failSendFor.add(ALICE.id)
    expect(await h.ask.execute(request())).toMatchObject({ status: 'failed' })
    expect([...h.store.rows.values()].map((c) => c.state)).toEqual(['cancelled'])
  })

  test('a question too long for the prompt goes in plain messages first', async () => {
    const h = harness()
    let first = true
    class TightGateway extends FakePromptGateway {
      override async sendPrompt(
        chatId: string,
        text: string,
        keyboard: PromptKeyboard,
      ): Promise<PromptRef> {
        if (first) {
          first = false
          throw new PromptTooLongError(9999)
        }
        return super.sendPrompt(chatId, text, keyboard)
      }
    }
    const gateway = new TightGateway()
    const prompts = new ChoicePrompts(gateway, h.chat, en, h.logger)
    const choice = Choice.open({
      id: 'abcdefghij',
      session: 'me',
      chatId: ALICE.id,
      question: 'long',
      options: ['a', 'b'],
      allowOther: false,
      now: 0,
    })
    await prompts.send(choice)
    expect(h.chat.sent.map((s) => s.text)).toEqual([en.choicePrompt('long')])
    expect(gateway.sent[0]?.text).toBe(en.choiceQuestionAbove)
  })
})

describe('AnswerChoice', () => {
  test('delivers the label once, tagged with the choice', async () => {
    const h = harness()
    const id = await askedId(h)
    expect(await h.answer.execute(tapInput(id, 1))).toBe('answered')
    expect(h.forwarded).toHaveLength(1)
    expect(h.forwarded[0]).toMatchObject({
      text: 'B',
      sender: ALICE,
      forwardContext: { kind: 'choice', choiceId: id },
    })
    expect(h.gateway.edits.at(-1)?.keyboard).toEqual([])
    expect(await h.answer.execute(tapInput(id, 0))).toBe('already_answered')
    expect(h.forwarded).toHaveLength(1)
    expect(h.audit.entries.map((e) => e.event)).toEqual(['choice.asked', 'choice.answered'])
  })

  test('the allowlist is checked again', async () => {
    const h = harness()
    const id = await askedId(h)
    expect(await h.answer.execute(tapInput(id, 0, MALLORY))).toBe('not_allowed')
    expect(h.forwarded).toEqual([])
  })

  test('another session, another chat or an unknown id: not found', async () => {
    const h = harness()
    const id = await askedId(h)
    const other = Choice.open({
      id: 'zzzzzzzzzz',
      session: 'someone-else',
      chatId: ALICE.id,
      question: 'q',
      options: ['a', 'b'],
      allowOther: false,
      now: h.clock.now(),
    })
    h.store.put(other)
    expect(await h.answer.execute(tapInput('zzzzzzzzzz', 0))).toBe('not_found')
    expect(await h.answer.execute({ ...tapInput(id, 0), chatId: '999' })).toBe('not_found')
    expect(await h.answer.execute(tapInput('aaaaaaaaaa', 0))).toBe('not_found')
    expect(await h.answer.execute(tapInput(id, 5))).toBe('not_found')
    expect(h.forwarded).toEqual([])
  })

  test('braked: nothing is delivered and the choice stays open', async () => {
    const h = harness()
    const id = await askedId(h)
    h.brake.engage({ engagedAt: 0, actor: 'terminal', reason: undefined })
    expect(await h.answer.execute(tapInput(id, 0))).toBe('braked')
    expect(await h.answer.execute(tapInput(id, 'other'))).toBe('braked')
    expect(h.store.findById(id)?.state).toBe('pending')
    expect(h.forwarded).toEqual([])
  })

  test('due: expires on the tap', async () => {
    const h = harness()
    const id = await askedId(h)
    h.clock.advance(CHOICE_TTL_MS)
    expect(await h.answer.execute(tapInput(id, 0))).toBe('expired')
    expect(h.store.findById(id)?.state).toBe('expired')
    expect(h.forwarded).toEqual([])
  })

  test('"other" waits for text; without allow_other it is not found', async () => {
    const h = harness()
    const id = await askedId(h)
    expect(await h.answer.execute(tapInput(id, 'other'))).toBe('awaiting_text')
    expect(h.store.findById(id)?.state).toBe('awaiting_text')
    expect(await h.answer.execute(tapInput(id, 0))).toBe('already_answered')
    const closed = await askedId(h, false)
    expect(await h.answer.execute(tapInput(closed, 'other'))).toBe('not_found')
  })

  test('a failed delivery reopens the choice', async () => {
    const h = harness()
    const id = await askedId(h)
    h.setForward('failed')
    expect(await h.answer.execute(tapInput(id, 0))).toBe('delivery_failed')
    expect(h.store.findById(id)?.state).toBe('pending')
    h.setForward('forwarded')
    expect(await h.answer.execute(tapInput(id, 0))).toBe('answered')
  })
})

describe('AnswerChoiceWithText', () => {
  test('the newest waiting choice of this chat and session is answered', async () => {
    const h = harness()
    const first = await askedId(h)
    h.clock.advance(1)
    const second = await askedId(h)
    await h.answer.execute(tapInput(first, 'other'))
    await h.answer.execute(tapInput(second, 'other'))
    expect(await h.withText.execute({ chatId: ALICE.id, sender: ALICE })).toBe(second)
    expect(h.store.findById(second)?.state).toBe('answered')
    expect(await h.withText.execute({ chatId: ALICE.id, sender: ALICE })).toBe(first)
    expect(await h.withText.execute({ chatId: ALICE.id, sender: ALICE })).toBeUndefined()
  })

  test('nothing waiting, another chat or a due choice: no answer', async () => {
    const h = harness()
    const id = await askedId(h)
    expect(await h.withText.execute({ chatId: ALICE.id, sender: ALICE })).toBeUndefined()
    await h.answer.execute(tapInput(id, 'other'))
    expect(await h.withText.execute({ chatId: '999', sender: ALICE })).toBeUndefined()
    h.clock.advance(CHOICE_TTL_MS)
    expect(await h.withText.execute({ chatId: ALICE.id, sender: ALICE })).toBeUndefined()
  })
})

describe('ExpireChoices', () => {
  test('expires due choices and edits their message', async () => {
    const h = harness()
    const id = await askedId(h)
    expect(await h.expire.execute()).toBe(0)
    h.clock.advance(CHOICE_TTL_MS)
    expect(await h.expire.execute()).toBe(1)
    expect(h.store.findById(id)?.state).toBe('expired')
    expect(h.gateway.edits.at(-1)?.text).toContain(en.choiceStatus({ status: 'expired' }))
    expect(h.audit.entries.at(-1)).toMatchObject({ event: 'choice.expired' })
  })

  test('orphans: open choices of other sessions are cancelled, ours kept', async () => {
    const h = harness()
    const ours = await askedId(h)
    h.store.put(
      Choice.open({
        id: 'zzzzzzzzzz',
        session: 'dead',
        chatId: ALICE.id,
        question: 'q',
        options: ['a', 'b'],
        allowOther: false,
        now: 0,
      }),
    )
    expect(await h.expire.expireOrphans()).toBe(1)
    expect(h.store.findById('zzzzzzzzzz')?.state).toBe('cancelled')
    expect(h.store.findById(ours)?.state).toBe('pending')
  })
})

test('choiceKeyboard: a closed choice has no buttons', () => {
  const choice = Choice.open({
    id: 'abcdefghij',
    session: 'me',
    chatId: '1',
    question: 'q',
    options: ['a', 'b'],
    allowOther: true,
    now: 0,
  })
  expect(choiceKeyboard(choice, en)).toHaveLength(3)
  expect(choiceKeyboard(choice.chooseOther(), en)).toEqual([])
  expect(choiceKeyboard(choice.expire(1), en)).toEqual([])
})
