import { describe, expect, mock, test } from 'bun:test'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { AttachmentStep } from '../../../src/application/pipeline/AttachmentStep.ts'
import { ChoiceTextAnswerStep } from '../../../src/application/pipeline/ChoiceTextAnswerStep.ts'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import { UnsupportedContentStep } from '../../../src/application/pipeline/UnsupportedContentStep.ts'
import type { AttachmentMessage } from '../../../src/application/use-cases/ReceiveAttachment.ts'
import { ALICE, FakeChatGateway, FakeClock, MemoryLogger } from '../../fakes.ts'

const en = messagesFor('en')
const photo = { kind: 'photo', sizes: [{ fileId: 'f', width: 1, height: 1, size: 1 }] } as const

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatId: ALICE.id,
    messageId: '10',
    chatKind: 'private',
    sender: ALICE,
    text: 'hello',
    sentAt: 0,
    ...overrides,
  }
}

describe('UnsupportedContentStep with attachments', () => {
  test('photos and files go on only when F10 is wired', async () => {
    const chat = new FakeChatGateway()
    const wired = new UnsupportedContentStep(
      chat,
      en.onlyTextSupported,
      new FakeClock(),
      new MemoryLogger(),
      true,
    )
    const next = mock(async (_m: InboundMessage) => {})
    await wired.handle(message({ text: undefined, attachment: photo }), next)
    expect(next).toHaveBeenCalledTimes(1)
    await wired.handle(message({ text: undefined }), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(chat.sent.map((s) => s.text)).toEqual([en.onlyTextSupported])

    const unwired = new UnsupportedContentStep(
      new FakeChatGateway(),
      en.onlyTextSupported,
      new FakeClock(),
      new MemoryLogger(),
    )
    await unwired.handle(message({ text: undefined, attachment: photo }), next)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('AttachmentStep', () => {
  test('starts the download and stops the chain; text goes on', async () => {
    const started: AttachmentMessage[] = []
    const step = new AttachmentStep({ start: (m) => void started.push(m) })
    const next = mock(async (_m: InboundMessage) => {})
    await step.handle(message({ attachment: photo, caption: 'c' }), next)
    expect(started).toHaveLength(1)
    expect(next).not.toHaveBeenCalled()
    await step.handle(message(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('ChoiceTextAnswerStep', () => {
  test('tags the text with the choice it answers', async () => {
    const step = new ChoiceTextAnswerStep({ execute: async () => 'abcdefghij' })
    const next = mock(async (_m: InboundMessage) => {})
    await step.handle(message(), next)
    expect(next.mock.calls[0]?.[0].forwardContext).toEqual({
      kind: 'choice',
      choiceId: 'abcdefghij',
    })
  })

  test('nothing waiting: passed on untouched; a tagged message is not looked at', async () => {
    const execute = mock(async () => undefined)
    const step = new ChoiceTextAnswerStep({ execute })
    const next = mock(async (_m: InboundMessage) => {})
    const plain = message()
    await step.handle(plain, next)
    expect(next.mock.calls[0]?.[0]).toBe(plain)
    const tagged = message({ forwardContext: { kind: 'choice', choiceId: 'zzzzzzzzzz' } })
    await step.handle(tagged, next)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[1]?.[0]).toBe(tagged)
  })
})
