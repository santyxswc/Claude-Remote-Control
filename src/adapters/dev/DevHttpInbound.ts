import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ChannelPort } from '../../application/ports/ChannelPort.ts'
import type { Logger } from '../../application/ports/Logger.ts'
import type { DevChatGateway, DevReply } from './DevChatGateway.ts'

/** Every dev event is addressed to this chat, so Claude's replies come back here. */
export const DEV_CHAT_ID = 'dev'

const LOOPBACK = '127.0.0.1'
const MAX_BODY_BYTES = 64 * 1024
const TOKEN_BYTES = 32

export interface DevHttpInboundOptions {
  /** TCP port on 127.0.0.1; `0` picks a free one. */
  readonly port: number
  readonly channel: ChannelPort
  readonly replies: DevChatGateway
  readonly logger: Logger
  /**
   * Where the token and the ready-to-paste curl lines are printed, once.
   * Defaults to stderr (stdout belongs to MCP). Never the logger: the token
   * must not end up in log files or audit rows.
   */
  readonly announce?: (text: string) => void
}

export interface DevHttpInbound {
  /** The port actually bound. */
  readonly port: number
  /** The bearer token of this run; random per start, never persisted. */
  readonly token: string
  stop(): Promise<void>
}

/**
 * Development-only stand-in for the Telegram adapter, reachable from curl:
 * `POST /` delivers the body to the session as a channel event and
 * `GET /events` streams Claude's replies as server-sent events.
 *
 * Anything that can reach it can type into the session, so: loopback only;
 * a random bearer token per start, required on every request; any request
 * with an `Origin` header is refused (browsers send one on cross-origin
 * requests, curl never does), and so is a `Host` other than
 * `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding). `main.ts` does
 * not start it at all when a bot token is configured.
 */
export function startDevHttpInbound(options: DevHttpInboundOptions): DevHttpInbound {
  const { channel, replies, logger } = options
  const encoder = new TextEncoder()
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expected = Buffer.from(`Bearer ${token}`)

  const server = Bun.serve({
    hostname: LOOPBACK,
    port: options.port,
    idleTimeout: 0, // SSE streams stay open with no traffic
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request, self) {
      const refused = refusal(request, self.port, expected)
      if (refused !== undefined) return refused
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
  const url = `http://${LOOPBACK}:${port}`
  logger.info('dev inbound listening', { url })
  const announce = options.announce ?? ((text: string) => void process.stderr.write(text))
  announce(
    [
      `telegram-bridge dev listener on ${url} (token valid until this process exits):`,
      `  send:    curl -X POST -H "Authorization: Bearer ${token}" --data "hello" ${url}/`,
      `  replies: curl -N -H "Authorization: Bearer ${token}" ${url}/events`,
      '',
    ].join('\n'),
  )

  return {
    port,
    token,
    async stop() {
      await server.stop(true)
    },
  }
}

/** Why a request is refused before it is looked at, or undefined to serve it. */
function refusal(
  request: Request,
  port: number | undefined,
  expected: Buffer,
): Response | undefined {
  if (request.headers.has('origin')) return forbidden('cross-origin requests are not accepted')
  const host = request.headers.get('host')?.toLowerCase()
  if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) {
    return forbidden('unexpected Host header')
  }
  const given = Buffer.from(request.headers.get('authorization') ?? '')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new Response('missing or wrong token\n', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
    })
  }
  return undefined
}

function forbidden(why: string): Response {
  return new Response(`${why}\n`, { status: 403 })
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
