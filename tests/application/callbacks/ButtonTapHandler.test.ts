import { describe, expect, test } from 'bun:test'
import { ButtonTapHandler } from '../../../src/application/callbacks/ButtonTapHandler.ts'
import type { InboundCallback } from '../../../src/application/callbacks/InboundCallback.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { TokenBucket } from '../../../src/domain/TokenBucket.ts'
import { ALICE, MALLORY } from '../../fakes.ts'
import { en, incoming, permissionHarness } from '../permissionHarness.ts'

async function setup(limiter?: TokenBucket) {
  const h = permissionHarness()
  await h.relay.execute(incoming())
  const handler = new ButtonTapHandler({
    authorize: new AuthorizeSender(h.allowed),
    resolve: h.resolve,
    prompts: h.gateway,
    messages: en,
    clock: h.clock,
    logger: h.logger,
    ...(limiter === undefined ? {} : { limiter }),
  })
  return { ...h, handler }
}

const tap = (overrides: Partial<InboundCallback> = {}): InboundCallback => ({
  id: 'cb1',
  chatId: ALICE.id,
  chatKind: 'private',
  sender: ALICE,
  data: 'p1:abcde:a',
  ...overrides,
})

test('an allowlisted tap resolves and is answered with a toast', async () => {
  const h = await setup()
  await h.handler.handle(tap())
  expect(h.verdicts.sent).toEqual([{ requestId: 'abcde', behavior: 'allow' }])
  expect(h.gateway.answers).toEqual([
    { callbackId: 'cb1', text: en.permissionFeedback('approved') },
  ])
})

test.each([
  ['a stranger', tap({ sender: MALLORY, chatId: MALLORY.id })],
  ['a group chat', tap({ chatKind: 'group', chatId: '-100123' })],
  ['no chat', tap({ chatKind: undefined, chatId: undefined })],
  ['no sender', tap({ sender: undefined })],
  ['someone else’s chat', tap({ chatId: '999' })],
])('%s: no verdict and not even an answer', async (_name, callback) => {
  const h = await setup()
  await h.handler.handle(callback)
  expect(h.verdicts.sent).toEqual([])
  expect(h.gateway.answers).toEqual([])
  expect(h.store.findById('abcde')?.state).toBe('pending')
})

test('malformed data from an allowlisted sender is answered with nothing and ignored', async () => {
  const h = await setup()
  await h.handler.handle(tap({ data: 'p1:abcde:allow' }))
  expect(h.gateway.answers).toEqual([{ callbackId: 'cb1' }])
  expect(h.verdicts.sent).toEqual([])
})

test('over the rate limit the tap is answered but not handled', async () => {
  const h = await setup(new TokenBucket({ burst: 1, refillMs: 60_000, noticeWindowMs: 0 }))
  await h.handler.handle(tap({ id: 'one', data: 'p1:zzzzz:a' }))
  await h.handler.handle(tap({ id: 'two' }))
  expect(h.gateway.answers).toEqual([
    { callbackId: 'one', text: en.permissionFeedback('not_found') },
    { callbackId: 'two' },
  ])
  expect(h.verdicts.sent).toEqual([])
})

test('a double tap gives one verdict and an "already resolved" toast', async () => {
  const h = await setup()
  await h.handler.handle(tap({ id: 'one' }))
  await h.handler.handle(tap({ id: 'two' }))
  expect(h.verdicts.sent).toHaveLength(1)
  expect(h.gateway.answers.at(-1)).toEqual({
    callbackId: 'two',
    text: en.permissionFeedback('already_resolved'),
  })
})

describe('routing by prefix', () => {
  async function routed() {
    const h = await setup()
    const choiceCalls: unknown[] = []
    const skillCalls: unknown[] = []
    const pages: unknown[] = []
    const handler = new ButtonTapHandler({
      authorize: new AuthorizeSender(h.allowed),
      resolve: h.resolve,
      choices: {
        execute: async (input) => {
          choiceCalls.push(input)
          return 'answered'
        },
      },
      skills: {
        menu: { showPage: async (ref, page) => void pages.push({ ref, page }) },
        request: {
          execute: async (input) => {
            skillCalls.push(input)
            return 'sent'
          },
        },
      },
      prompts: h.gateway,
      messages: en,
      clock: h.clock,
      logger: h.logger,
    })
    return { ...h, handler, choiceCalls, skillCalls, pages }
  }

  test('a choice tap goes to the choices only and is never a verdict', async () => {
    const h = await routed()
    await h.handler.handle(tap({ data: 'c1:abcdefghij:0', messageId: '9' }))
    expect(h.choiceCalls).toEqual([
      { choiceId: 'abcdefghij', pick: 0, sender: ALICE, chatId: ALICE.id, messageId: '9' },
    ])
    expect(h.verdicts.sent).toEqual([])
    expect(h.store.findById('abcde')?.state).toBe('pending')
    expect(h.gateway.answers).toEqual([{ callbackId: 'cb1', text: en.choiceFeedback('answered') }])
  })

  test('a permission tap never reaches the choices or the skills', async () => {
    const h = await routed()
    await h.handler.handle(tap())
    expect(h.verdicts.sent).toHaveLength(1)
    expect(h.choiceCalls).toEqual([])
    expect(h.skillCalls).toEqual([])
  })

  test('skill and page taps', async () => {
    const h = await routed()
    await h.handler.handle(tap({ data: 'k1:0123abcd', messageId: '9' }))
    await h.handler.handle(tap({ id: 'cb2', data: 'k1:p2', messageId: '9' }))
    expect(h.skillCalls).toEqual([
      { key: '0123abcd', sender: ALICE, chatId: ALICE.id, messageId: '9' },
    ])
    expect(h.pages).toEqual([{ ref: { chatId: ALICE.id, messageId: '9' }, page: 2 }])
    expect(h.gateway.answers).toEqual([
      { callbackId: 'cb1', text: en.skillFeedback('sent') },
      { callbackId: 'cb2' },
    ])
  })

  test.each(['c1:abcdefghij:9', 'c1:abcde:a', 'k1:p1:x', 'p1:abcdefghij:0', 'x'])(
    'mixed or malformed %p reaches nothing',
    async (data) => {
      const h = await routed()
      await h.handler.handle(tap({ data }))
      expect(h.choiceCalls).toEqual([])
      expect(h.skillCalls).toEqual([])
      expect(h.verdicts.sent).toEqual([])
    },
  )

  test('a stranger choice tap is dropped before routing', async () => {
    const h = await routed()
    await h.handler.handle(tap({ sender: MALLORY, chatId: MALLORY.id, data: 'c1:abcdefghij:0' }))
    expect(h.choiceCalls).toEqual([])
    expect(h.gateway.answers).toEqual([])
  })
})
