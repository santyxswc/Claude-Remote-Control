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
import {
  toInboundCallback,
  toInboundMessage,
} from '../../../src/adapters/telegram/toInboundMessage.ts'
import { BotUnreachableError, InvalidBotTokenError } from '../../../src/application/errors.ts'
import { FakeClock, FakeSleeper } from '../../fakes.ts'
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
  function setup() {
    const api = new FakeTelegramApi()
    const sleeper = new FakeSleeper(new FakeClock())
    const gateway = new TelegramChatGateway(TEST_TOKEN, { fetch: api.fetch, sleeper })
    return { api, sleeper, gateway }
  }

  const flood = (retryAfter: number) =>
    ({
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${retryAfter}`,
      parameters: { retry_after: retryAfter },
    }) as const

  test('sends plain text: no parse mode, link previews disabled', async () => {
    const { api, gateway } = setup()
    expect(await gateway.sendText('5000000001', 'hi *there* https://x.test')).toEqual({
      parts: 1,
      redactions: 0,
    })
    expect(api.calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: '5000000001',
          text: 'hi *there* https://x.test',
          link_preview_options: { is_disabled: true },
        },
      },
    ])
  })

  test('threads under replyTo, and still sends if that message is gone', async () => {
    const { api, gateway } = setup()
    await gateway.sendText('5000000001', 'answer', { replyTo: '77' })
    expect(api.calls[0]?.payload.reply_parameters).toEqual({
      message_id: 77,
      allow_sending_without_reply: true,
    })
  })

  test('sendTyping sends the typing chat action', async () => {
    const { api, gateway } = setup()
    await gateway.sendTyping('5000000001')
    expect(api.calls).toEqual([
      { method: 'sendChatAction', payload: { chat_id: '5000000001', action: 'typing' } },
    ])
  })

  test('a 429 waits retry_after through the sleeper and retries', async () => {
    const { api, sleeper, gateway } = setup()
    api.script('sendMessage', flood(3), flood(1))
    await gateway.sendText('1', 'x')
    expect(sleeper.naps).toEqual([3000, 1000])
    expect(api.callsTo('sendMessage')).toHaveLength(3)
  })

  test('M1: a send waiting out a flood wait holds up no other send (no global queue)', async () => {
    const api = new FakeTelegramApi()
    let wake = () => {}
    const gateway = new TelegramChatGateway(TEST_TOKEN, {
      fetch: api.fetch,
      sleeper: { sleep: () => new Promise<void>((resolve) => (wake = resolve)) },
    })
    api.script('sendMessage', flood(60))
    const waiting = gateway.sendText('1', 'stuck behind a flood wait')
    await gateway.sendText('1', 'the /stop report')
    expect(api.callsTo('sendMessage').map((c) => c.payload.text)).toEqual([
      'stuck behind a flood wait',
      'the /stop report',
    ])
    wake()
    await waiting
    expect(api.callsTo('sendMessage')).toHaveLength(3)
  })

  test('retries are bounded', async () => {
    const { api, sleeper, gateway } = setup()
    api.script('sendMessage', flood(1), flood(1), flood(1), flood(1))
    const error = await gateway.sendText('1', 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TelegramCallError)
    expect((error as TelegramCallError).summary.code).toBe(429)
    expect(sleeper.naps).toEqual([1000, 1000, 1000])
    expect(api.callsTo('sendMessage')).toHaveLength(4)
  })

  test('a very long retry_after fails at once instead of blocking the reply', async () => {
    const { api, sleeper, gateway } = setup()
    api.script('sendMessage', flood(3600))
    await expect(gateway.sendText('1', 'x')).rejects.toBeInstanceOf(TelegramCallError)
    expect(sleeper.naps).toEqual([])
  })

  test('failures surface as TelegramCallError without the token', async () => {
    const { api, gateway } = setup()
    api.script('sendMessage', {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    })
    const error = await gateway.sendText('1', 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TelegramCallError)
    expect((error as Error).message).toBe('403: Forbidden: bot was blocked by the user')
  })

  test('network errors are redacted, for typing too', async () => {
    const { api, gateway } = setup()
    api.script('sendChatAction', { networkError: `connect https://x/bot${TEST_TOKEN}/x` })
    const error = await gateway.sendTyping('1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TelegramCallError)
    expect((error as Error).message).not.toContain(TEST_TOKEN)
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
      messageId: '1',
      chatKind: 'private',
      sender: { id: '7000000003', username: undefined, displayName: 'Ana Gómez' },
      text: 'hi',
      sentAt: 0,
    })
  })

  test('sanitizes the name and the username at the boundary', () => {
    const message = {
      ...base,
      chat: { id: 999, type: 'private', first_name: 'x' },
      from: {
        id: 999,
        is_bot: false,
        first_name: 'Santiago (@santi_real), id 12345678',
        last_name: '\u{202e}999 di ,\u001b[2K\nline',
        username: 'x\u{200b}y',
      },
    } as Message
    const sender = toInboundMessage(message).sender
    expect(sender?.id).toBe('999')
    expect(sender?.username).toBeUndefined()
    expect(sender?.displayName).toBe('Santiago (@santi_real), id 12345678 999 di , [2K line')
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

describe('TelegramChatGateway prompts', () => {
  const keyboard = [
    [
      { label: 'Approve', data: 'p1:abcde:a' },
      { label: 'Deny', data: 'p1:abcde:d' },
    ],
  ]

  test('sendPrompt: plain text, no preview, inline keyboard; returns the message ref', async () => {
    const api = new FakeTelegramApi()
    const gateway = new TelegramChatGateway(TEST_TOKEN, { fetch: api.fetch })
    const ref = await gateway.sendPrompt('5000000001', '<b>x</b> [y](z)', keyboard)
    const payload = api.callsTo('sendMessage')[0]?.payload
    expect(payload?.parse_mode).toBeUndefined()
    expect(payload?.text).toBe('<b>x</b> [y](z)')
    expect(payload?.link_preview_options).toEqual({ is_disabled: true })
    expect(payload?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: 'p1:abcde:a' },
          { text: 'Deny', callback_data: 'p1:abcde:d' },
        ],
      ],
    })
    expect(ref).toEqual({ chatId: '5000000001', messageId: '1000' })
  })

  test('editPrompt replaces text and keyboard; an empty keyboard removes the buttons', async () => {
    const api = new FakeTelegramApi()
    const gateway = new TelegramChatGateway(TEST_TOKEN, { fetch: api.fetch })
    await gateway.editPrompt({ chatId: '5000000001', messageId: '77' }, 'done', [])
    expect(api.callsTo('editMessageText')[0]?.payload).toMatchObject({
      chat_id: '5000000001',
      message_id: 77,
      text: 'done',
      reply_markup: { inline_keyboard: [] },
    })
  })

  test('editing to identical content is not an error; other failures are', async () => {
    const api = new FakeTelegramApi()
    const gateway = new TelegramChatGateway(TEST_TOKEN, { fetch: api.fetch })
    api.script('editMessageText', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message is not modified',
    })
    await gateway.editPrompt({ chatId: '1', messageId: '2' }, 'x', [])
    api.script('editMessageText', {
      ok: false,
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    })
    await expect(gateway.editPrompt({ chatId: '1', messageId: '2' }, 'x', [])).rejects.toThrow(
      'message to edit not found',
    )
  })

  test('answerCallback with and without a toast', async () => {
    const api = new FakeTelegramApi()
    const gateway = new TelegramChatGateway(TEST_TOKEN, { fetch: api.fetch })
    await gateway.answerCallback('cb1', 'Approved.')
    await gateway.answerCallback('cb2')
    expect(api.callsTo('answerCallbackQuery').map((c) => c.payload)).toEqual([
      { callback_query_id: 'cb1', text: 'Approved.' },
      { callback_query_id: 'cb2' },
    ] as never)
  })

  test('callback data over 64 bytes is refused before any request', async () => {
    const api = new FakeTelegramApi()
    const gateway = new TelegramChatGateway(TEST_TOKEN, { fetch: api.fetch })
    await expect(
      gateway.sendPrompt('1', 'x', [[{ label: 'x', data: 'é'.repeat(33) }]]),
    ).rejects.toThrow('callback data')
    expect(api.calls).toEqual([])
  })
})

describe('toInboundCallback', () => {
  test('maps ids to strings and keeps the chat kind', () => {
    expect(
      toInboundCallback({
        id: 'q1',
        from: { id: 5_000_000_001, is_bot: false, first_name: 'Owner', username: 'owner' },
        chat_instance: 'ci',
        data: 'p1:abcde:a',
        message: {
          message_id: 7,
          date: 0,
          chat: { id: 5_000_000_001, type: 'private', first_name: 'Owner' },
        },
      } as never),
    ).toEqual({
      id: 'q1',
      chatId: '5000000001',
      chatKind: 'private',
      sender: { id: '5000000001', username: 'owner', displayName: 'Owner' },
      data: 'p1:abcde:a',
    })
  })

  test('a tap without a message has no chat; a bot has no sender', () => {
    const mapped = toInboundCallback({
      id: 'q2',
      from: { id: 1, is_bot: true, first_name: 'Bot' },
      chat_instance: 'ci',
      inline_message_id: 'im',
    } as never)
    expect(mapped).toEqual({
      id: 'q2',
      chatId: undefined,
      chatKind: undefined,
      sender: undefined,
      data: undefined,
    })
  })
})
