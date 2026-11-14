import { describe, expect, test } from 'bun:test'
import { PartialDeliveryError } from '../../../src/application/errors.ts'
import { ChunkingChatGateway } from '../../../src/application/outbound/ChunkingChatGateway.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { SendReply } from '../../../src/application/use-cases/SendReply.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import {
  ALICE,
  FakeChatGateway,
  FakeClock,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  MALLORY,
  MemoryLogger,
} from '../../fakes.ts'

function setup() {
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, 0))
  const chat = new FakeChatGateway()
  const audit = new InMemoryAuditLog()
  const logger = new MemoryLogger()
  const clock = new FakeClock()
  const useCase = new SendReply({
    chat,
    authorize: new AuthorizeSender(allowed),
    extraChatIds: new Set(['dev']),
    audit,
    clock,
    logger,
  })
  return { allowed, chat, audit, logger, clock, useCase }
}

describe('SendReply', () => {
  test('sends to an allowlisted private chat and audits ids and counts only', async () => {
    const { chat, audit, useCase } = setup()
    expect(await useCase.execute({ chatId: ALICE.id, text: 'all green', replyTo: '5' })).toEqual({
      status: 'sent',
      parts: 1,
      redactions: 0,
    })
    expect(chat.sent).toEqual([{ chatId: ALICE.id, text: 'all green', options: { replyTo: '5' } }])
    expect(audit.entries).toMatchObject([
      {
        actor: 'session',
        event: 'reply.sent',
        details: { chatId: ALICE.id, parts: 1, redactions: 0 },
      },
    ])
    expect(JSON.stringify(audit.entries)).not.toContain('all green')
  })

  test.each([
    ['a stranger', MALLORY.id, MALLORY.id],
    ['a group', '-1001234567890', '-1001234567890'],
    ['a username', '@somechannel', 'invalid'],
    ['garbage', 'x'.repeat(500), 'invalid'],
  ])('refuses %s and audits it', async (_label, chatId, recorded) => {
    const { chat, audit, useCase } = setup()
    expect(await useCase.execute({ chatId, text: 'leak' })).toEqual({
      status: 'refused',
      reason: 'chat_not_allowed',
    })
    expect(chat.sent).toEqual([])
    expect(audit.entries).toMatchObject([
      { event: 'reply.refused', details: { chatId: recorded, reason: 'chat_not_allowed' } },
    ])
    expect(JSON.stringify(audit.entries)).not.toContain('leak')
  })

  test('revocation takes effect immediately', async () => {
    const { allowed, useCase } = setup()
    expect((await useCase.execute({ chatId: ALICE.id, text: 'one' })).status).toBe('sent')
    allowed.remove(ALICE.id)
    expect((await useCase.execute({ chatId: ALICE.id, text: 'two' })).status).toBe('refused')
  })

  test('extra chat ids (the dev listener) are allowed', async () => {
    const { useCase } = setup()
    expect((await useCase.execute({ chatId: 'dev', text: 'hi' })).status).toBe('sent')
  })

  test.each([
    ['empty text', { text: '  \n ' }, 'empty_text'],
    ['bad reply_to', { text: 'x', replyTo: 'abc' }, 'invalid_reply_to'],
    ['zero reply_to', { text: 'x', replyTo: '0' }, 'invalid_reply_to'],
  ] as const)('refuses %s', async (_label, input, reason) => {
    const { chat, useCase } = setup()
    expect(await useCase.execute({ chatId: ALICE.id, ...input })).toEqual({
      status: 'refused',
      reason,
    })
    expect(chat.sent).toEqual([])
  })

  test('a partial delivery reports and audits how many parts arrived', async () => {
    const { chat, audit, useCase } = setup()
    chat.failWith = new PartialDeliveryError(2, 5, new Error('502'))
    expect(await useCase.execute({ chatId: ALICE.id, text: 'long' })).toEqual({
      status: 'failed',
      delivered: 2,
      total: 5,
      error: 'Delivered 2 of 5 parts; then: 502',
    })
    expect(audit.entries).toMatchObject([
      { event: 'reply.failed', details: { chatId: ALICE.id, delivered: 2, total: 5 } },
    ])
  })

  test('works with a real chunking gateway end to end', async () => {
    const inner = new FakeChatGateway()
    const allowed = new InMemoryAllowedSenders()
    allowed.add(allowSender(ALICE, 0))
    const useCase = new SendReply({
      chat: new ChunkingChatGateway(inner, 10),
      authorize: new AuthorizeSender(allowed),
      extraChatIds: new Set(),
      audit: new InMemoryAuditLog(),
      clock: new FakeClock(),
      logger: new MemoryLogger(),
    })
    expect(await useCase.execute({ chatId: ALICE.id, text: 'aaaa bbbb cccc' })).toEqual({
      status: 'sent',
      parts: 2,
      redactions: 0,
    })
  })

  test('a plain failure reports zero delivered', async () => {
    const { chat, useCase } = setup()
    chat.failWith = new Error('403: Forbidden')
    expect(await useCase.execute({ chatId: ALICE.id, text: 'x' })).toEqual({
      status: 'failed',
      delivered: 0,
      total: undefined,
      error: '403: Forbidden',
    })
  })
})

describe('SendReply observer', () => {
  test('onSent fires only for a delivered reply', async () => {
    const { allowed, chat, audit, logger, clock } = setup()
    let sent = 0
    const useCase = new SendReply({
      chat,
      authorize: new AuthorizeSender(allowed),
      extraChatIds: new Set(),
      audit,
      clock,
      logger,
      onSent: () => {
        sent += 1
      },
    })
    await useCase.execute({ chatId: MALLORY.id, text: 'refused' })
    expect(sent).toBe(0)
    await useCase.execute({ chatId: ALICE.id, text: 'ok' })
    expect(sent).toBe(1)
    chat.failWith = new Error('down')
    await useCase.execute({ chatId: ALICE.id, text: 'fails' })
    expect(sent).toBe(1)
  })
})
