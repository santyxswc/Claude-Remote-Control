import { describe, expect, test } from 'bun:test'
import type { Message } from 'grammy/types'
import { TelegramAttachmentSource } from '../../../src/adapters/telegram/TelegramAttachmentSource.ts'
import { toInboundMessage } from '../../../src/adapters/telegram/toInboundMessage.ts'
import { FakeTelegramApi, TEST_TOKEN } from '../../fakeTelegram.ts'

const SECRET = TEST_TOKEN.split(':')[1] ?? TEST_TOKEN

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = []
  for await (const chunk of chunks) out.push(...chunk)
  return out
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a failure')
}

describe('TelegramAttachmentSource', () => {
  test('getFile then a streamed download', async () => {
    const api = new FakeTelegramApi()
    api.addFile('f1', {
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      path: 'documents/file_9.pdf',
      chunkSize: 2,
    })
    const source = new TelegramAttachmentSource(TEST_TOKEN, { fetch: api.fetch })
    const file = await source.open('f1', new AbortController().signal)
    expect(file.size).toBe(5)
    expect(await collect(file.chunks)).toEqual([1, 2, 3, 4, 5])
    expect(api.callsTo('getFile')[0]?.payload.file_id).toBe('f1')
    expect(api.downloads).toEqual(['documents/file_9.pdf'])
  })

  test.each([
    ['a network error that names the URL', { networkError: true }],
    ['an HTTP error', { status: 500 }],
  ])('%s never carries the token', async (_what, options) => {
    const api = new FakeTelegramApi()
    api.addFile('f', { bytes: new Uint8Array([1]), ...options })
    const source = new TelegramAttachmentSource(TEST_TOKEN, { fetch: api.fetch })
    const error = await failure(source.open('f', new AbortController().signal))
    expect(JSON.stringify({ message: error.message, stack: error.stack, error })).not.toContain(
      SECRET,
    )
  })

  test('an unknown file id fails without the token', async () => {
    const api = new FakeTelegramApi()
    const source = new TelegramAttachmentSource(TEST_TOKEN, { fetch: api.fetch })
    const error = await failure(source.open('nope', new AbortController().signal))
    expect(`${error.message} ${error.stack}`).not.toContain(SECRET)
  })

  test.each(['../../etc/passwd', 'a/../b', '/abs', 'a b', 'x?y'])(
    'a file path %p is never used',
    async (path) => {
      const api = new FakeTelegramApi()
      api.addFile('f', { bytes: new Uint8Array([1]), path })
      const source = new TelegramAttachmentSource(TEST_TOKEN, { fetch: api.fetch })
      await failure(source.open('f', new AbortController().signal))
      expect(api.downloads).toEqual([])
    },
  )

  test('an abort cancels a stuck download', async () => {
    const api = new FakeTelegramApi()
    api.addFile('f', { bytes: new Uint8Array([1]), stall: true })
    const source = new TelegramAttachmentSource(TEST_TOKEN, { fetch: api.fetch })
    const controller = new AbortController()
    const file = await source.open('f', controller.signal)
    const reading = collect(file.chunks)
    controller.abort()
    const error = await failure(reading)
    expect(error.message).not.toContain(SECRET)
  })
})

describe('toInboundMessage with media', () => {
  const base = {
    message_id: 3,
    date: 0,
    chat: { id: 42, type: 'private', first_name: 'A' },
    from: { id: 42, is_bot: false, first_name: 'A' },
  }

  test('a photo keeps its sizes, caption and album id', () => {
    const message = {
      ...base,
      caption: 'look',
      media_group_id: 'g1',
      photo: [
        { file_id: 's', file_unique_id: 'us', width: 90, height: 90, file_size: 10 },
        { file_id: 'l', file_unique_id: 'ul', width: 900, height: 900 },
      ],
    } as unknown as Message
    expect(toInboundMessage(message)).toMatchObject({
      caption: 'look',
      mediaGroupId: 'g1',
      attachment: {
        kind: 'photo',
        sizes: [
          { fileId: 's', width: 90, height: 90, size: 10 },
          { fileId: 'l', width: 900, height: 900, size: undefined },
        ],
      },
    })
  })

  test('a document keeps its name and declared size', () => {
    const message = {
      ...base,
      document: { file_id: 'd', file_unique_id: 'ud', file_name: 'a.pdf', file_size: 7 },
    } as unknown as Message
    expect(toInboundMessage(message).attachment).toEqual({
      kind: 'document',
      fileId: 'd',
      fileName: 'a.pdf',
      size: 7,
    })
  })

  test('an animation (which also sets document) is not an attachment', () => {
    const message = {
      ...base,
      animation: { file_id: 'a', file_unique_id: 'ua', width: 1, height: 1, duration: 1 },
      document: { file_id: 'a', file_unique_id: 'ua' },
    } as unknown as Message
    expect(toInboundMessage(message).attachment).toBeUndefined()
  })
})
