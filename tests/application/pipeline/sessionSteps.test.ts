import { describe, expect, mock, test } from 'bun:test'
import { CommandRegistry } from '../../../src/application/commands/CommandRegistry.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { BrakeGateStep } from '../../../src/application/pipeline/BrakeGateStep.ts'
import { CommandRouterStep } from '../../../src/application/pipeline/CommandRouterStep.ts'
import { createSessionSteps } from '../../../src/application/pipeline/createSessionSteps.ts'
import { ForwardToSessionStep } from '../../../src/application/pipeline/ForwardToSessionStep.ts'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import { buildPipeline } from '../../../src/application/pipeline/InboundStep.ts'
import { RateLimitStep } from '../../../src/application/pipeline/RateLimitStep.ts'
import { StaleMessageStep } from '../../../src/application/pipeline/StaleMessageStep.ts'
import { UnsupportedContentStep } from '../../../src/application/pipeline/UnsupportedContentStep.ts'
import { HandleInboundMessage } from '../../../src/application/use-cases/HandleInboundMessage.ts'
import {
  BRAKE_NOTICE_WINDOW_MS,
  UNSUPPORTED_NOTICE_WINDOW_MS,
} from '../../../src/domain/inboundLimits.ts'
import { TokenBucket } from '../../../src/domain/TokenBucket.ts'
import {
  ALICE,
  FakeChannel,
  FakeChatGateway,
  FakeClock,
  FakeSessionActivity,
  InMemoryAuditLog,
  InMemoryBrakeFlag,
  MemoryLogger,
} from '../../fakes.ts'

const en = messagesFor('en')

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatId: ALICE.id,
    messageId: '10',
    chatKind: 'private',
    sender: ALICE,
    text: 'hello',
    sentAt: 1_700_000_000_000,
    ...overrides,
  }
}

const nextSpy = () => mock(async (_m: InboundMessage) => {})

describe('RateLimitStep', () => {
  function setup() {
    const chat = new FakeChatGateway()
    const audit = new InMemoryAuditLog()
    const clock = new FakeClock()
    const logger = new MemoryLogger()
    const step = new RateLimitStep({
      limiter: new TokenBucket({ burst: 2, refillMs: 3000, noticeWindowMs: 60_000 }),
      clock,
      chat,
      audit,
      logger,
      slowDown: en.slowDown,
    })
    return { chat, audit, clock, logger, step }
  }

  test('passes messages within the limit', async () => {
    const { step } = setup()
    const next = nextSpy()
    await step.handle(message(), next)
    await step.handle(message(), next)
    expect(next).toHaveBeenCalledTimes(2)
  })

  test('over the limit: drops, tells the sender once per window, audits that once', async () => {
    const { step, chat, audit, clock } = setup()
    const next = nextSpy()
    for (let i = 0; i < 10; i++) await step.handle(message({ text: `m${i}` }), next)
    expect(next).toHaveBeenCalledTimes(2)
    expect(chat.sent).toEqual([{ chatId: ALICE.id, text: en.slowDown }])
    expect(audit.entries).toEqual([
      {
        at: clock.now(),
        actor: `telegram:${ALICE.id}`,
        event: 'message.rate_limited',
        details: { senderId: ALICE.id },
      },
    ])
    expect(JSON.stringify(audit.entries)).not.toContain('m3')
  })

  test('refills over time', async () => {
    const { step, clock } = setup()
    const next = nextSpy()
    for (let i = 0; i < 3; i++) await step.handle(message(), next)
    clock.advance(3000)
    await step.handle(message(), next)
    expect(next).toHaveBeenCalledTimes(3)
  })

  test('a failing notice is logged, not thrown', async () => {
    const { step, chat, logger } = setup()
    chat.failWith = new Error('down')
    for (let i = 0; i < 3; i++) await step.handle(message(), nextSpy())
    expect(logger.entries.at(-1)).toMatchObject({ level: 'warn' })
  })
})

describe('UnsupportedContentStep', () => {
  function setup() {
    const chat = new FakeChatGateway()
    const clock = new FakeClock()
    const step = new UnsupportedContentStep(chat, en.onlyTextSupported, clock, new MemoryLogger())
    return { chat, clock, step }
  }

  test('text passes on', async () => {
    const next = nextSpy()
    await setup().step.handle(message(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('non-text is never forwarded and the sender is told once per window', async () => {
    const { step, chat, clock } = setup()
    const next = nextSpy()
    for (let i = 0; i < 5; i++) await step.handle(message({ text: undefined }), next)
    expect(next).not.toHaveBeenCalled()
    expect(chat.sent).toEqual([{ chatId: ALICE.id, text: en.onlyTextSupported }])
    clock.advance(UNSUPPORTED_NOTICE_WINDOW_MS)
    await step.handle(message({ text: undefined }), next)
    expect(chat.sent).toHaveLength(2)
  })
})

describe('CommandRouterStep', () => {
  function setup(botUsername: string | undefined = 'test_bot') {
    const chat = new FakeChatGateway()
    const logger = new MemoryLogger()
    const ran: string[] = []
    const registry = new CommandRegistry().register({
      name: 'ping',
      description: 'pong',
      execute: async (ctx) => {
        ran.push(ctx.args)
        await ctx.reply('pong')
      },
    })
    return { chat, logger, ran, step: new CommandRouterStep(registry, chat, logger, botUsername) }
  }

  test.each([['/ping'], ['/ping@test_bot'], ['/PING@Test_Bot']])(
    '%p runs the command and stops the chain',
    async (text) => {
      const { step, chat, ran } = setup()
      const next = nextSpy()
      await step.handle(message({ text }), next)
      expect(ran).toEqual([''])
      expect(chat.sent).toEqual([{ chatId: ALICE.id, text: 'pong' }])
      expect(next).not.toHaveBeenCalled()
    },
  )

  test('passes arguments', async () => {
    const { step, ran } = setup()
    await step.handle(message({ text: '/ping a b' }), nextSpy())
    expect(ran).toEqual(['a b'])
  })

  test.each([['/deploy prod'], ['/ping@other_bot'], ['plain text'], ['/ping-x']])(
    '%p is forwarded, not swallowed',
    async (text) => {
      const { step, chat } = setup()
      const next = nextSpy()
      await step.handle(message({ text }), next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(chat.sent).toEqual([])
    },
  )

  test('a failing command is logged, not thrown, and not forwarded', async () => {
    const chat = new FakeChatGateway()
    const logger = new MemoryLogger()
    const registry = new CommandRegistry().register({
      name: 'boom',
      description: '',
      execute: async () => {
        throw new Error('broken')
      },
    })
    const next = nextSpy()
    await new CommandRouterStep(registry, chat, logger, undefined).handle(
      message({ text: '/boom' }),
      next,
    )
    expect(next).not.toHaveBeenCalled()
    expect(logger.entries.at(-1)).toMatchObject({ level: 'error', message: 'chat command failed' })
  })
})

describe('ForwardToSessionStep', () => {
  test('hands text messages to the use case', async () => {
    const channel = new FakeChannel()
    const forward = new HandleInboundMessage({
      channel,
      chat: new FakeChatGateway(),
      activity: new FakeSessionActivity(),
      audit: new InMemoryAuditLog(),
      clock: new FakeClock(),
      logger: new MemoryLogger(),
      messages: en,
    })
    await new ForwardToSessionStep(forward).handle(message(), nextSpy())
    await new ForwardToSessionStep(forward).handle(message({ text: undefined }), nextSpy())
    expect(channel.events).toHaveLength(1)
  })
})

describe('createSessionSteps', () => {
  test('order: rate limit, text only, commands, forward', () => {
    const steps = createSessionSteps({
      chat: new FakeChatGateway(),
      messages: en,
      logger: new MemoryLogger(),
      clock: new FakeClock(),
      audit: new InMemoryAuditLog(),
      commands: new CommandRegistry(),
      forward: {} as HandleInboundMessage,
      botUsername: undefined,
    })
    expect(steps.map((s) => s.constructor.name)).toEqual([
      'RateLimitStep',
      'UnsupportedContentStep',
      'CommandRouterStep',
      'ForwardToSessionStep',
    ])
  })

  test('rate limiting applies to commands too', async () => {
    const chat = new FakeChatGateway()
    let runs = 0
    const commands = new CommandRegistry().register({
      name: 'ping',
      description: '',
      execute: async () => {
        runs++
      },
    })
    const pipeline = buildPipeline(
      createSessionSteps({
        chat,
        messages: en,
        logger: new MemoryLogger(),
        clock: new FakeClock(),
        audit: new InMemoryAuditLog(),
        commands,
        forward: {} as HandleInboundMessage,
        botUsername: undefined,
        limiter: new TokenBucket({ burst: 1, refillMs: 1000, noticeWindowMs: 1000 }),
      }),
    )
    await pipeline(message({ text: '/ping' }))
    await pipeline(message({ text: '/ping' }))
    expect(runs).toBe(1)
  })
})

describe('BrakeGateStep', () => {
  function setup() {
    const brake = new InMemoryBrakeFlag()
    const chat = new FakeChatGateway()
    const clock = new FakeClock()
    const step = new BrakeGateStep(brake, chat, en.brakeHeldMessage, clock, new MemoryLogger())
    return { brake, chat, clock, step }
  }

  test('passes everything on while the brake is released', async () => {
    const { step, chat } = setup()
    const next = nextSpy()
    await step.handle(message(), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(chat.sent).toEqual([])
  })

  test('while engaged (or unreadable) holds messages and says so once per window', async () => {
    const { brake, step, chat, clock } = setup()
    brake.unreadable = true
    const next = nextSpy()
    await step.handle(message(), next)
    await step.handle(message({ messageId: '11' }), next)
    clock.advance(BRAKE_NOTICE_WINDOW_MS)
    await step.handle(message({ messageId: '12' }), next)
    expect(next).not.toHaveBeenCalled()
    expect(chat.sent.map((s) => s.text)).toEqual([en.brakeHeldMessage, en.brakeHeldMessage])
  })
})

describe('createSessionSteps with the brake', () => {
  test('the gate sits after the commands, right before delivery', () => {
    const steps = createSessionSteps({
      chat: new FakeChatGateway(),
      messages: en,
      logger: new MemoryLogger(),
      clock: new FakeClock(),
      audit: new InMemoryAuditLog(),
      commands: new CommandRegistry(),
      forward: {} as HandleInboundMessage,
      botUsername: undefined,
      brake: new InMemoryBrakeFlag(),
    })
    expect(steps.map((s) => s.constructor.name)).toEqual([
      'RateLimitStep',
      'UnsupportedContentStep',
      'CommandRouterStep',
      'BrakeGateStep',
      'ForwardToSessionStep',
    ])
  })
})

describe('StaleMessageStep', () => {
  const STARTED_AT = 1_700_000_600_000
  const GRACE_MS = 60_000

  function setup() {
    const chat = new FakeChatGateway()
    const audit = new InMemoryAuditLog()
    const clock = new FakeClock(STARTED_AT + 5_000)
    const logger = new MemoryLogger()
    const step = new StaleMessageStep({
      sessionStartedAt: STARTED_AT,
      graceMs: GRACE_MS,
      clock,
      chat,
      audit,
      logger,
      notice: en.staleMessagesIgnored,
    })
    return { chat, audit, clock, logger, step }
  }

  test('a message sent after the session started passes', async () => {
    const { step, chat, audit } = setup()
    const next = nextSpy()
    await step.handle(message({ sentAt: STARTED_AT + 1_000 }), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(chat.sent).toEqual([])
    expect(audit.entries).toEqual([])
  })

  test('the margin lets through a message sent just before the start', async () => {
    const { step } = setup()
    const next = nextSpy()
    await step.handle(message({ sentAt: STARTED_AT - GRACE_MS }), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('older messages are dropped, audited by age and never by text, with one notice', async () => {
    const { step, chat, audit, clock, logger } = setup()
    const next = nextSpy()
    await step.handle(
      message({ messageId: '7', text: 'deploy to production', sentAt: STARTED_AT - GRACE_MS - 1 }),
      next,
    )
    await step.handle(
      message({ messageId: '8', text: '/resume', sentAt: STARTED_AT - 3_600_000 }),
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(chat.sent).toEqual([{ chatId: ALICE.id, text: en.staleMessagesIgnored }])
    expect(audit.entries).toEqual([
      {
        at: clock.now(),
        actor: `telegram:${ALICE.id}`,
        event: 'message.stale_dropped',
        details: { senderId: ALICE.id, messageId: '7', ageSeconds: 60 },
      },
      {
        at: clock.now(),
        actor: `telegram:${ALICE.id}`,
        event: 'message.stale_dropped',
        details: { senderId: ALICE.id, messageId: '8', ageSeconds: 3600 },
      },
    ])
    expect(JSON.stringify(audit.entries)).not.toContain('deploy')
    expect(logger.text).not.toContain('deploy')
    expect(logger.text).not.toContain('/resume')
  })

  test('a notice that cannot be sent does not stop later messages', async () => {
    const { step, chat } = setup()
    chat.failWith = new Error('telegram down')
    const next = nextSpy()
    await step.handle(message({ sentAt: STARTED_AT - 3_600_000 }), next)
    chat.failWith = undefined
    await step.handle(message({ sentAt: STARTED_AT + 1 }), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('createSessionSteps: a stale command or message never reaches the rest of the chain', async () => {
    const chat = new FakeChatGateway()
    const channel = new FakeChannel()
    const audit = new InMemoryAuditLog()
    const clock = new FakeClock(STARTED_AT)
    const logger = new MemoryLogger()
    const steps = createSessionSteps({
      chat,
      messages: en,
      logger,
      clock,
      audit,
      commands: new CommandRegistry(),
      forward: new HandleInboundMessage({
        channel,
        chat,
        activity: new FakeSessionActivity(),
        audit,
        clock,
        logger,
        messages: en,
      }),
      botUsername: 'demo_bot',
      sessionStartedAt: STARTED_AT,
    })
    const handle = buildPipeline(steps)

    await handle(message({ text: 'old instruction', sentAt: STARTED_AT - 86_000_000 }))
    await handle(message({ text: 'new instruction', sentAt: STARTED_AT + 2_000 }))

    expect(channel.events.map((event) => event.content)).toEqual(['new instruction'])
    expect(chat.sent.map((sent) => sent.text)).toEqual([en.staleMessagesIgnored])
  })
})
