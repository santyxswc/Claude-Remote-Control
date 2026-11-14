import { describe, expect, test } from 'bun:test'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import {
  type ForwardableMessage,
  HandleInboundMessage,
} from '../../../src/application/use-cases/HandleInboundMessage.ts'
import {
  ALICE,
  FakeChannel,
  FakeChatGateway,
  FakeClock,
  FakeSessionActivity,
  InMemoryAuditLog,
  MemoryLogger,
} from '../../fakes.ts'

const en = messagesFor('en')

function setup(activity = new FakeSessionActivity()) {
  const channel = new FakeChannel()
  const chat = new FakeChatGateway()
  const audit = new InMemoryAuditLog()
  const clock = new FakeClock()
  const logger = new MemoryLogger()
  const useCase = new HandleInboundMessage({
    channel,
    chat,
    activity,
    audit,
    clock,
    logger,
    messages: en,
  })
  return { channel, chat, audit, clock, logger, activity, useCase }
}

const message: ForwardableMessage = {
  chatId: ALICE.id,
  messageId: '42',
  chatKind: 'private',
  sender: ALICE,
  text: 'please run the tests',
  sentAt: Date.UTC(2026, 10, 13, 8, 0, 5),
}

describe('HandleInboundMessage', () => {
  test('emits the text with chat_id, message_id, user and ts', async () => {
    const { channel, useCase } = setup()
    expect(await useCase.execute(message)).toBe('forwarded')
    expect(channel.events).toEqual([
      {
        content: 'please run the tests',
        meta: {
          chat_id: ALICE.id,
          message_id: '42',
          user: 'alice',
          ts: '2026-11-13T08:00:05.000Z',
        },
      },
    ])
  })

  test('falls back to the display name when there is no username', async () => {
    const { channel, useCase } = setup()
    await useCase.execute({ ...message, sender: { ...ALICE, username: undefined } })
    expect(channel.events[0]).toMatchObject({ meta: { user: 'Alice A' } })
  })

  test('audits and logs ids and length, never the text', async () => {
    const { audit, logger, useCase, clock } = setup()
    await useCase.execute(message)
    expect(audit.entries).toEqual([
      {
        at: clock.now(),
        actor: `telegram:${ALICE.id}`,
        event: 'message.forwarded',
        details: { senderId: ALICE.id, messageId: '42', length: message.text.length },
      },
    ])
    expect(JSON.stringify(audit.entries) + logger.text).not.toContain('run the tests')
  })

  test('acknowledges with typing and no text while activity is unknown or idle', async () => {
    for (const state of ['unknown', 'idle'] as const) {
      const { chat, useCase } = setup(new FakeSessionActivity(state))
      await useCase.execute(message)
      expect(chat.typing).toEqual([ALICE.id])
      expect(chat.sent).toEqual([])
    }
  })

  test('says "queued" when the session is busy', async () => {
    const { chat, useCase } = setup(new FakeSessionActivity('busy'))
    await useCase.execute(message)
    expect(chat.typing).toEqual([ALICE.id])
    expect(chat.sent).toEqual([{ chatId: ALICE.id, text: en.queued }])
  })

  test('a failed typing acknowledgement is logged and ignored', async () => {
    const { chat, logger, useCase } = setup()
    chat.typingFailWith = new Error('429')
    expect(await useCase.execute(message)).toBe('forwarded')
    expect(logger.entries.at(-1)).toMatchObject({ level: 'warn' })
  })

  test('a failed emit tells the sender and audits nothing', async () => {
    const { channel, chat, audit, useCase } = setup()
    channel.failWith = new Error('transport closed')
    expect(await useCase.execute(message)).toBe('failed')
    expect(chat.sent).toEqual([{ chatId: ALICE.id, text: en.deliveryFailed }])
    expect(chat.typing).toEqual([])
    expect(audit.entries).toEqual([])
  })
})
