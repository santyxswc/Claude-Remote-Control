import { describe, expect, test } from 'bun:test'
import { EmptyMessageError, PartialDeliveryError } from '../../../src/application/errors.ts'
import { ChunkingChatGateway } from '../../../src/application/outbound/ChunkingChatGateway.ts'
import { RedactingChatGateway } from '../../../src/application/outbound/RedactingChatGateway.ts'
import { RedactingPromptGateway } from '../../../src/application/outbound/RedactingPromptGateway.ts'
import { REDACTION_MARK } from '../../../src/domain/redaction/SecretRedactor.ts'
import { createSecretRedactor } from '../../../src/domain/redaction/secretValues.ts'
import { FakeChatGateway, FakePromptGateway } from '../../fakes.ts'

const SECRET = 'Zq8!vR2#pL-0042'

describe('RedactingChatGateway', () => {
  test('replaces secrets before the inner gateway sees the text and reports the count', async () => {
    const inner = new FakeChatGateway()
    const gateway = new RedactingChatGateway(inner, createSecretRedactor([SECRET]))

    const receipt = await gateway.sendText('1', `a ${SECRET} b ${SECRET}`, { replyTo: '9' })

    expect(inner.sent).toEqual([
      { chatId: '1', text: `a ${REDACTION_MARK} b ${REDACTION_MARK}`, options: { replyTo: '9' } },
    ])
    expect(receipt).toEqual({ parts: 1, redactions: 2 })
  })

  test('typing passes through', async () => {
    const inner = new FakeChatGateway()
    await new RedactingChatGateway(inner, createSecretRedactor([])).sendTyping('1')
    expect(inner.typing).toEqual(['1'])
  })
})

describe('ChunkingChatGateway', () => {
  test('a short text is one message with the options', async () => {
    const inner = new FakeChatGateway()
    const receipt = await new ChunkingChatGateway(inner, 10).sendText('1', 'hi', { replyTo: '3' })
    expect(inner.sent).toEqual([{ chatId: '1', text: 'hi', options: { replyTo: '3' } }])
    expect(receipt).toEqual({ parts: 1, redactions: 0 })
  })

  test('sends the parts in order and threads only the first', async () => {
    const inner = new FakeChatGateway()
    const receipt = await new ChunkingChatGateway(inner, 10).sendText(
      '1',
      'aaaa bbbb cccc dddd eeee',
      {
        replyTo: '3',
      },
    )
    expect(inner.sent).toEqual([
      { chatId: '1', text: 'aaaa bbbb', options: { replyTo: '3' } },
      { chatId: '1', text: 'cccc dddd' },
      { chatId: '1', text: 'eeee' },
    ])
    expect(receipt.parts).toBe(3)
  })

  test('a failure midway stops and says how many parts were delivered', async () => {
    const inner = new FakeChatGateway()
    inner.failWith = new Error('502: Bad Gateway')
    inner.failFromCall = 1
    const error = await new ChunkingChatGateway(inner, 10)
      .sendText('1', 'aaaa bbbb cccc dddd eeee')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PartialDeliveryError)
    expect(error).toMatchObject({ delivered: 1, total: 3 })
    expect((error as Error).message).toBe('Delivered 1 of 3 parts; then: 502: Bad Gateway')
    expect(inner.sent).toHaveLength(1)
  })

  test('a single-part failure is rethrown as is', async () => {
    const inner = new FakeChatGateway()
    inner.failWith = new Error('403: blocked')
    await expect(new ChunkingChatGateway(inner, 10).sendText('1', 'hi')).rejects.toBe(
      inner.failWith,
    )
  })

  test('whitespace-only text is refused before any send', async () => {
    const inner = new FakeChatGateway()
    await expect(new ChunkingChatGateway(inner, 10).sendText('1', ' \n ')).rejects.toBeInstanceOf(
      EmptyMessageError,
    )
    expect(inner.sent).toEqual([])
  })
})

describe('redaction runs before chunking', () => {
  test('a secret straddling a chunk boundary never leaves in pieces', async () => {
    const inner = new FakeChatGateway()
    const gateway = new RedactingChatGateway(
      new ChunkingChatGateway(inner, 20),
      createSecretRedactor([SECRET]),
    )
    // Without redaction first, the 20-unit hard cut would fall inside the secret.
    await gateway.sendText('1', `${'x'.repeat(12)}${SECRET}${'y'.repeat(30)}`)
    const sent = inner.sent.map((m) => m.text).join('')
    expect(sent).not.toContain(SECRET.slice(0, 8))
    expect(sent).not.toContain(SECRET.slice(8))
    expect(sent).toContain(REDACTION_MARK)
  })
})

describe('RedactingPromptGateway', () => {
  const keyboard = [[{ label: 'OK', data: 'p1:abcde:a' }]]

  test('redacts prompts, edits and toasts; buttons pass through untouched', async () => {
    const inner = new FakePromptGateway()
    const gateway = new RedactingPromptGateway(inner, createSecretRedactor([SECRET]), 4096)
    const ref = await gateway.sendPrompt('1', `run ${SECRET}`, keyboard)
    await gateway.editPrompt(ref, `done ${SECRET}`, [])
    await gateway.answerCallback('cb', `toast ${SECRET}`)
    await gateway.answerCallback('cb2')
    expect(inner.sent).toEqual([{ chatId: '1', text: `run ${REDACTION_MARK}`, keyboard }])
    expect(inner.edits).toEqual([{ ref, text: `done ${REDACTION_MARK}`, keyboard: [] }])
    expect(inner.answers).toEqual([
      { callbackId: 'cb', text: `toast ${REDACTION_MARK}` },
      { callbackId: 'cb2' },
    ])
  })

  test('a prompt grown by redaction still fits one message, keeping both ends', async () => {
    const inner = new FakePromptGateway()
    const secrets = Array.from({ length: 400 }, (_, i) => `Qz${String(i).padStart(6, '0')}`)
    const gateway = new RedactingPromptGateway(inner, createSecretRedactor(secrets), 3500)
    const text = `HEAD ${secrets.join(' ')} TAIL`
    expect(text.length).toBeLessThan(3700)
    await gateway.sendPrompt('1', text, keyboard)
    const sent = inner.sent[0]?.text ?? ''
    expect(sent.length).toBeLessThanOrEqual(3500)
    expect(sent.startsWith('HEAD ')).toBe(true)
    expect(sent.endsWith(' TAIL')).toBe(true)
    expect(sent).not.toContain('Qz000')
  })
})
