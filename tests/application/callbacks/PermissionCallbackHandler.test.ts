import { expect, test } from 'bun:test'
import type { InboundCallback } from '../../../src/application/callbacks/InboundCallback.ts'
import { PermissionCallbackHandler } from '../../../src/application/callbacks/PermissionCallbackHandler.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { TokenBucket } from '../../../src/domain/TokenBucket.ts'
import { ALICE, MALLORY } from '../../fakes.ts'
import { en, incoming, permissionHarness } from '../permissionHarness.ts'

async function setup(limiter?: TokenBucket) {
  const h = permissionHarness()
  await h.relay.execute(incoming())
  const handler = new PermissionCallbackHandler({
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
