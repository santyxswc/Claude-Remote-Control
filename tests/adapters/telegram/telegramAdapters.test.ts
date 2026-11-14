import { describe, expect, test } from 'bun:test'
import type { Message } from 'grammy/types'
import { isPlausibleBotToken } from '../../../src/adapters/telegram/botToken.ts'
import {
  describeTelegramError,
  redactToken,
  TelegramCallError,
} from '../../../src/adapters/telegram/redact.ts'
import { TelegramChatGateway } from '../../../src/adapters/telegram/TelegramChatGateway.ts'
import { TelegramDeepLinks } from '../../../src/adapters/telegram/TelegramDeepLinks.ts'
import { TelegramIdentityProbe } from '../../../src/adapters/telegram/TelegramIdentityProbe.ts'
import { toInboundMessage } from '../../../src/adapters/telegram/toInboundMessage.ts'
import { BotUnreachableError, InvalidBotTokenError } from '../../../src/application/errors.ts'
import { FakeTelegramApi, TEST_TOKEN } from '../../fakeTelegram.ts'

describe('TelegramIdentityProbe', () => {
  test('returns the bot id and username from getMe', async () => {
    const api = new FakeTelegramApi()
    expect(await new TelegramIdentityProbe(api.fetch).probe(TEST_TOKEN)).toEqual({
      id: '123456789',
      username: 'test_bot',
    })
  })

  test('a malformed token is rejected without any request', async () => {
    const api = new FakeTelegramApi()
    await expect(new TelegramIdentityProbe(api.fetch).probe('hunter2')).rejects.toBeInstanceOf(
      InvalidBotTokenError,
    )
    expect(api.calls).toEqual([])
  })

  test.each([[401], [404]])('Telegram answering %p means an invalid token', async (code) => {
    const api = new FakeTelegramApi()
    api.script('getMe', { ok: false, error_code: code, description: 'Unauthorized' })
    await expect(new TelegramIdentityProbe(api.fetch).probe(TEST_TOKEN)).rejects.toBeInstanceOf(
      InvalidBotTokenError,
    )
  })

  test('network failures are "unreachable" and never carry the token', async () => {
    const api = new FakeTelegramApi()
    api.script('getMe', {
      networkError: `ENOTFOUND https://api.telegram.org/bot${TEST_TOKEN}/getMe`,
    })
    const error = await new TelegramIdentityProbe(api.fetch)
      .probe(TEST_TOKEN)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BotUnreachableError)
    expect(String((error as Error).message)).not.toContain(TEST_TOKEN)
  })
})

describe('TelegramChatGateway', () => {
  test('sends plain text with no parse mode', async () => {
    const api = new FakeTelegramApi()
    await new TelegramChatGateway(TEST_TOKEN, api.fetch).sendText('5000000001', 'hi *there*')
    expect(api.calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: '5000000001', text: 'hi *there*' } },
    ])
  })

  test('failures surface as TelegramCallError without the token', async () => {
    const api = new FakeTelegramApi()
    api.script('sendMessage', {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    })
    const error = await new TelegramChatGateway(TEST_TOKEN, api.fetch)
      .sendText('1', 'x')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TelegramCallError)
    expect((error as Error).message).toBe('403: Forbidden: bot was blocked by the user')
  })
})

describe('toInboundMessage', () => {
  const base = { message_id: 1, date: 0, text: 'hi' }

  test('keeps ids exact as decimal strings and joins first and last name', () => {
    const message = {
      ...base,
      chat: { id: 7_000_000_003, type: 'private', first_name: 'Ana' },
      from: { id: 7_000_000_003, is_bot: false, first_name: 'Ana', last_name: 'Gómez' },
    } as Message
    expect(toInboundMessage(message)).toEqual({
      chatId: '7000000003',
      chatKind: 'private',
      sender: { id: '7000000003', username: undefined, displayName: 'Ana Gómez' },
      text: 'hi',
      sentAt: 0,
    })
  })

  test('groups keep their (negative) chat id and kind; bots are not senders', () => {
    const message = {
      ...base,
      chat: { id: -1001234567890, type: 'supergroup', title: 'g' },
      from: { id: 42, is_bot: true, first_name: 'Other bot' },
    } as Message
    expect(toInboundMessage(message)).toMatchObject({
      chatId: '-1001234567890',
      chatKind: 'supergroup',
      sender: undefined,
    })
  })
})

describe('token hygiene helpers', () => {
  test('redactToken removes the token and anything token-shaped', () => {
    expect(redactToken(`GET /bot${TEST_TOKEN}/getMe`, TEST_TOKEN)).toBe('GET /bot[redacted]/getMe')
    expect(redactToken('x 987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123 y', undefined)).toBe(
      'x [redacted] y',
    )
  })

  test('describeTelegramError never includes the token', () => {
    const summary = describeTelegramError(new Error(`failed ${TEST_TOKEN}`), TEST_TOKEN)
    expect(summary).toEqual({ name: 'Error', message: 'failed [redacted]' })
    expect(describeTelegramError('weird', TEST_TOKEN)).toEqual({
      name: 'UnknownError',
      message: 'weird',
    })
  })

  test.each([
    [TEST_TOKEN, true],
    ['123:short', false],
    ['abc:AAHtestTOKENdoNotUse_0123456789abcdef', false],
    [`${TEST_TOKEN} `, false],
    ['hunter2', false],
  ])('isPlausibleBotToken(%p) is %p', (token, expected) => {
    expect(isPlausibleBotToken(token)).toBe(expected)
  })

  test('deep links carry the code as the start parameter', () => {
    expect(new TelegramDeepLinks('test_bot').linkFor('abc-DEF_123')).toBe(
      'https://t.me/test_bot?start=abc-DEF_123',
    )
  })
})
