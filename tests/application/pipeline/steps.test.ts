import { describe, expect, mock, test } from 'bun:test'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { AuthenticateSenderStep } from '../../../src/application/pipeline/AuthenticateSenderStep.ts'
import { DiscardStep } from '../../../src/application/pipeline/DiscardStep.ts'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import { buildPipeline, type InboundStep } from '../../../src/application/pipeline/InboundStep.ts'
import { PairingClaimStep } from '../../../src/application/pipeline/PairingClaimStep.ts'
import { PrivateChatOnlyStep } from '../../../src/application/pipeline/PrivateChatOnlyStep.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import {
  ALICE,
  FakeChatGateway,
  InMemoryAllowedSenders,
  MALLORY,
  MemoryLogger,
} from '../../fakes.ts'
import { pairingHarness } from '../harness.ts'

const es = messagesFor('es')

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatId: ALICE.id,
    chatKind: 'private',
    sender: ALICE,
    text: 'hello',
    sentAt: 1_700_000_000_000,
    ...overrides,
  }
}

function nextSpy() {
  return mock(async (_m: InboundMessage) => {})
}

describe('buildPipeline', () => {
  test('runs steps in order and stops when a step does not call next', async () => {
    const order: string[] = []
    const step = (name: string, pass: boolean): InboundStep => ({
      async handle(m, next) {
        order.push(name)
        if (pass) await next(m)
      },
    })
    await buildPipeline([step('a', true), step('b', false), step('c', true)])(message())
    expect(order).toEqual(['a', 'b'])
  })

  test('an empty pipeline drops the message', async () => {
    await expect(buildPipeline([])(message())).resolves.toBeUndefined()
  })
})

describe('PrivateChatOnlyStep', () => {
  test('passes private chats on', async () => {
    const next = nextSpy()
    await new PrivateChatOnlyStep(new MemoryLogger()).handle(message(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test.each([['group'], ['supergroup'], ['channel']] as const)(
    'drops %s chats',
    async (chatKind) => {
      const next = nextSpy()
      const logger = new MemoryLogger()
      await new PrivateChatOnlyStep(logger).handle(message({ chatKind, text: 'secret plan' }), next)
      expect(next).not.toHaveBeenCalled()
      expect(logger.text).not.toContain('secret plan')
    },
  )
})

describe('PairingClaimStep', () => {
  function setup() {
    const h = pairingHarness()
    const chat = new FakeChatGateway()
    const logger = new MemoryLogger()
    const step = new PairingClaimStep(h.claim, chat, es, logger)
    return { h, chat, logger, step }
  }

  test('a correct /start code claims, replies once and stops the chain', async () => {
    const { h, chat, logger, step } = setup()
    const { code } = h.start.execute()
    const next = nextSpy()

    await step.handle(message({ text: `/start ${code}` }), next)

    expect(h.pairings.findActive()?.state).toBe('claimed')
    expect(chat.sent).toEqual([{ chatId: ALICE.id, text: es.pairingClaimedReply }])
    expect(next).not.toHaveBeenCalled()
    expect(logger.text).not.toContain(code)
  })

  test('accepts the /start@bot_name form', async () => {
    const { h, step } = setup()
    const { code } = h.start.execute()
    await step.handle(message({ text: `/start@test_bot ${code}` }), nextSpy())
    expect(h.pairings.findActive()?.state).toBe('claimed')
  })

  test('a wrong code gets silence, is consumed, and is not logged', async () => {
    const { h, chat, logger, step } = setup()
    h.start.execute()
    const next = nextSpy()

    await step.handle(message({ sender: MALLORY, text: '/start not-the-code' }), next)

    expect(chat.sent).toEqual([])
    expect(next).not.toHaveBeenCalled()
    expect(h.pairings.findActive()?.failedAttempts).toBe(1)
    expect(logger.text).not.toContain('not-the-code')
  })

  test.each([['hello'], ['/start'], ['/help x'], [undefined]])(
    '%p is passed on untouched',
    async (text) => {
      const { h, chat, step } = setup()
      h.start.execute()
      const next = nextSpy()
      await step.handle(message({ text }), next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(chat.sent).toEqual([])
      expect(h.pairings.findActive()?.failedAttempts).toBe(0)
    },
  )

  test('a failed acknowledgement is logged, not thrown', async () => {
    const { h, chat, logger, step } = setup()
    const { code } = h.start.execute()
    chat.failWith = new Error('network down')

    await step.handle(message({ text: `/start ${code}` }), nextSpy())

    expect(h.pairings.findActive()?.state).toBe('claimed')
    expect(logger.entries.at(-1)).toMatchObject({ level: 'warn' })
  })
})

describe('AuthenticateSenderStep', () => {
  function setup() {
    const allowed = new InMemoryAllowedSenders()
    allowed.add(allowSender(ALICE, 0))
    const logger = new MemoryLogger()
    return { logger, step: new AuthenticateSenderStep(new AuthorizeSender(allowed), logger) }
  }

  test('passes allowlisted senders on', async () => {
    const next = nextSpy()
    await setup().step.handle(message(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('drops unknown senders silently and logs the id but not the text', async () => {
    const { step, logger } = setup()
    const next = nextSpy()
    await step.handle(message({ sender: MALLORY, chatId: MALLORY.id, text: 'rm -rf /' }), next)
    expect(next).not.toHaveBeenCalled()
    expect(logger.entries).toEqual([
      {
        level: 'info',
        message: 'dropped message from an unauthorized sender',
        fields: { senderId: MALLORY.id },
      },
    ])
    expect(logger.text).not.toContain('rm -rf')
  })

  test('authenticates by sender id, never by chat id', async () => {
    const next = nextSpy()
    // An allowlisted id as the chat id does not help a stranger.
    await setup().step.handle(message({ sender: MALLORY, chatId: ALICE.id }), next)
    expect(next).not.toHaveBeenCalled()
  })

  test('drops messages without a sender', async () => {
    const next = nextSpy()
    await setup().step.handle(message({ sender: undefined }), next)
    expect(next).not.toHaveBeenCalled()
  })
})

test('DiscardStep never calls next', async () => {
  const next = nextSpy()
  await new DiscardStep().handle(message(), next)
  expect(next).not.toHaveBeenCalled()
})
