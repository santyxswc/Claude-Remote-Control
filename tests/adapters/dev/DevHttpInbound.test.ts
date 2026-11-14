import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DevChatGateway } from '../../../src/adapters/dev/DevChatGateway.ts'
import {
  DEV_CHAT_ID,
  type DevHttpInbound,
  startDevHttpInbound,
} from '../../../src/adapters/dev/DevHttpInbound.ts'
import type { ChannelEvent, ChannelPort } from '../../../src/application/ports/ChannelPort.ts'
import { MemoryLogger } from '../../fakes.ts'

class RecordingChannel implements ChannelPort {
  readonly events: ChannelEvent[] = []
  failWith: Error | undefined

  async emit(event: ChannelEvent): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith
    this.events.push(event)
  }
}

let channel: RecordingChannel
let replies: DevChatGateway
let logger: MemoryLogger
let inbound: DevHttpInbound
let baseUrl: string

beforeEach(() => {
  channel = new RecordingChannel()
  replies = new DevChatGateway()
  logger = new MemoryLogger()
  inbound = startDevHttpInbound({ port: 0, channel, replies, logger })
  baseUrl = `http://127.0.0.1:${inbound.port}`
})

afterEach(async () => {
  await inbound.stop()
})

describe('startup', () => {
  test('binds an ephemeral loopback port and logs the URL', () => {
    expect(inbound.port).toBeGreaterThan(0)
    expect(logger.entries).toEqual([
      { level: 'info', message: 'dev inbound listening', fields: { url: baseUrl } },
    ])
  })

  test('throws when the port is already taken', () => {
    expect(() =>
      startDevHttpInbound({ port: inbound.port, channel, replies, logger: new MemoryLogger() }),
    ).toThrow()
  })
})

describe('POST /', () => {
  test('forwards the body to the session as a channel event for chat "dev"', async () => {
    const response = await fetch(`${baseUrl}/`, { method: 'POST', body: 'list the files' })

    expect(response.status).toBe(200)
    expect(channel.events).toEqual([{ content: 'list the files', meta: { chat_id: DEV_CHAT_ID } }])
  })

  test('rejects an empty body', async () => {
    const response = await fetch(`${baseUrl}/`, { method: 'POST', body: '  ' })

    expect(response.status).toBe(400)
    expect(channel.events).toEqual([])
  })

  test('answers 500 and logs when the channel cannot emit', async () => {
    channel.failWith = new Error('not connected')

    const response = await fetch(`${baseUrl}/`, { method: 'POST', body: 'hi' })

    expect(response.status).toBe(500)
    expect(logger.entries.at(-1)).toMatchObject({
      level: 'error',
      message: 'dev inbound: emit failed',
    })
  })

  test('rejects other methods and paths', async () => {
    expect((await fetch(`${baseUrl}/`)).status).toBe(405)
    expect((await fetch(`${baseUrl}/events`, { method: 'POST', body: 'x' })).status).toBe(405)
    expect((await fetch(`${baseUrl}/nope`, { method: 'POST', body: 'x' })).status).toBe(404)
    expect(channel.events).toEqual([])
  })
})

describe('GET /events', () => {
  test('streams replies sent through the dev gateway as server-sent events', async () => {
    const abort = new AbortController()
    const response = await fetch(`${baseUrl}/events`, { signal: abort.signal })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('no body')
    const decoder = new TextDecoder()

    let received = decoder.decode((await reader.read()).value)
    expect(received).toBe(': connected\n\n')

    await replies.sendText('dev', 'line one\nline two')
    while (!received.endsWith('}\n\n')) {
      received += decoder.decode((await reader.read()).value)
    }

    expect(received).toBe(
      ': connected\n\nevent: reply\ndata: {"chat_id":"dev","text":"line one\\nline two"}\n\n',
    )
    abort.abort()
  })
})
