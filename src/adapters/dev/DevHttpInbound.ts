import type { ChannelPort } from '../../application/ports/ChannelPort.ts'
import type { Logger } from '../../application/ports/Logger.ts'
import type { DevChatGateway, DevReply } from './DevChatGateway.ts'

/** Every dev event is addressed to this chat, so Claude's replies come back here. */
export const DEV_CHAT_ID = 'dev'

const LOOPBACK = '127.0.0.1'
const MAX_BODY_BYTES = 64 * 1024

export interface DevHttpInboundOptions {
  /** TCP port on 127.0.0.1; `0` picks a free one. */
  readonly port: number
  readonly channel: ChannelPort
  readonly replies: DevChatGateway
  readonly logger: Logger
}

export interface DevHttpInbound {
  /** The port actually bound. */
  readonly port: number
  stop(): Promise<void>
}

/**
 * Development-only stand-in for the Telegram adapter, reachable from curl:
 * `POST /` delivers the body to the session as a channel event and
 * `GET /events` streams Claude's replies as server-sent events.
 * It binds to the loopback interface only.
 */
export function startDevHttpInbound(options: DevHttpInboundOptions): DevHttpInbound {
  const { channel, replies, logger } = options
  const encoder = new TextEncoder()

  const server = Bun.serve({
    hostname: LOOPBACK,
    port: options.port,
    idleTimeout: 0, // SSE streams stay open with no traffic
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request) {
      const { pathname } = new URL(request.url)

      if (pathname === '/events') {
        if (request.method !== 'GET') return methodNotAllowed('GET')
        return eventStream(request, replies, encoder)
      }

      if (pathname === '/') {
        if (request.method !== 'POST') return methodNotAllowed('POST')
        const content = await request.text()
        if (content.trim() === '') {
          return new Response('empty body\n', { status: 400 })
        }
        try {
          await channel.emit({ content, meta: { chat_id: DEV_CHAT_ID } })
        } catch (error) {
          logger.error('dev inbound: emit failed', { error })
          return new Response('emit failed\n', { status: 500 })
        }
        return new Response('ok\n')
      }

      return new Response('not found\n', { status: 404 })
    },
  })

  const port = server.port
  if (port === undefined) {
    throw new Error('dev inbound: server did not bind a TCP port')
  }
  logger.info('dev inbound listening', { url: `http://${LOOPBACK}:${port}` })

  return {
    port,
    async stop() {
      await server.stop(true)
    },
  }
}

function methodNotAllowed(allow: string): Response {
  return new Response('method not allowed\n', { status: 405, headers: { Allow: allow } })
}

function eventStream(request: Request, replies: DevChatGateway, encoder: TextEncoder): Response {
  let unsubscribe = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'))
      unsubscribe = replies.subscribe((reply: DevReply) => {
        controller.enqueue(encoder.encode(`event: reply\ndata: ${JSON.stringify(reply)}\n\n`))
      })
      request.signal.addEventListener('abort', () => unsubscribe())
    },
    cancel() {
      unsubscribe()
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
