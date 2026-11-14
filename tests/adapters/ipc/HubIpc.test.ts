/**
 * F14 hub IPC over a real named pipe (Windows) or Unix socket (elsewhere) in
 * a temp state directory: the framing and its HMAC, then the server and the
 * client end to end.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac, randomBytes } from 'node:crypto'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { hubEndpoint } from '../../../src/adapters/ipc/endpoint.ts'
import {
  HubClient,
  HubRequestError,
  HubUnavailableError,
} from '../../../src/adapters/ipc/HubClient.ts'
import { HubLink, type HubLinkClose } from '../../../src/adapters/ipc/HubLink.ts'
import { HubServer, type RegistrationAnswer } from '../../../src/adapters/ipc/HubServer.ts'
import type { HubRequest } from '../../../src/adapters/ipc/hubProtocol.ts'
import type { SpokeChannel } from '../../../src/application/hub/HubRegistry.ts'
import { SpokeRequestRefusedError } from '../../../src/application/hub/TopicBoundGateway.ts'
import { StatusFloodWaitError } from '../../../src/application/ports/StatusMessageGateway.ts'
import { ALICE, MemoryLogger } from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

const SECRET = randomBytes(32)

let dir: string
let logger: MemoryLogger
const cleanups: (() => Promise<void> | void)[] = []

beforeEach(() => {
  dir = makeTempDir()
  logger = new MemoryLogger()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  removeTempDir(dir)
})

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1500 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

describe('HubLink framing', () => {
  /** A raw server whose connections are HubLinks; the test speaks the wire format by hand. */
  async function rawPeer(): Promise<{
    socket: Socket
    lines: string[]
    closes: HubLinkClose[]
    frames: unknown[]
    serverNonce: () => string
  }> {
    const endpoint = hubEndpoint(dir)
    const closes: HubLinkClose[] = []
    const frames: unknown[] = []
    const server: Server = createServer((socket) => {
      new HubLink(socket, {
        secret: SECRET,
        role: 'server',
        onFrame: (frame) => frames.push(frame),
        onClose: (reason) => closes.push(reason),
        maxFrameBytes: 4096,
        handshakeTimeoutMs: 200,
      })
    })
    await new Promise<void>((resolve) => server.listen(endpoint.path, resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const socket = connect(endpoint.path)
    cleanups.push(() => void socket.destroy())
    const lines: string[] = []
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
        lines.push(buffered.slice(0, nl))
        buffered = buffered.slice(nl + 1)
      }
    })
    socket.on('error', () => {})
    await until(() => lines.length > 0, 'the hello')
    return {
      socket,
      lines,
      closes,
      frames,
      serverNonce: () => (lines[0] ?? '').split(' ')[1] ?? '',
    }
  }

  const CLIENT_NONCE = 'ab'.repeat(16)

  function frame(serverNonce: string, seq: number, json: string, secret = SECRET): string {
    const mac = createHmac('sha256', secret)
      .update(`tb2|${serverNonce}|${CLIENT_NONCE}|c|${seq}|`)
      .update(json)
      .digest('base64url')
    return `tb2 ${mac} ${json}\n`
  }

  test('authentic frames arrive in order', async () => {
    const peer = await rawPeer()
    peer.socket.write(`tb2-hello ${CLIENT_NONCE}\n`)
    peer.socket.write(frame(peer.serverNonce(), 0, '{"n":1}'))
    peer.socket.write(frame(peer.serverNonce(), 1, '{"n":2}'))
    await until(() => peer.frames.length === 2, 'the frames')
    expect(peer.frames).toEqual([{ n: 1 }, { n: 2 }])
    expect(peer.closes).toEqual([])
  })

  test.each([
    ['a wrong key', (n: string) => frame(n, 0, '{"n":1}', randomBytes(32)), 'unauthenticated'],
    [
      'a replayed sequence number',
      (n: string) => frame(n, 0, '{}') + frame(n, 0, '{}'),
      'unauthenticated',
    ],
    [
      'a tampered body',
      (n: string) => frame(n, 0, '{"n":1}').replace('"n":1', '"n":2'),
      'unauthenticated',
    ],
    [
      'a forged MAC',
      (n: string) => frame(n, 0, '{}').replace(/^tb2 \S+/, `tb2 ${'A'.repeat(43)}`),
      'unauthenticated',
    ],
    ['an unknown version', (n: string) => frame(n, 0, '{}').replace(/^tb2 /, 'tb9 '), 'malformed'],
    ['no JSON', (n: string) => frame(n, 0, 'not json'), 'malformed'],
    [
      'an oversized frame',
      (n: string) => frame(n, 0, JSON.stringify({ x: 'y'.repeat(5000) })),
      'oversize',
    ],
  ])('%s closes the link', async (_, bad, reason) => {
    const peer = await rawPeer()
    peer.socket.write(`tb2-hello ${CLIENT_NONCE}\n`)
    peer.socket.write(bad(peer.serverNonce()))
    await until(() => peer.closes.length === 1, 'the close')
    expect(peer.closes).toEqual([reason as HubLinkClose])
    expect(peer.frames.length).toBeLessThanOrEqual(1)
  })

  test('a peer that never says hello is cut off', async () => {
    const peer = await rawPeer()
    await until(() => peer.closes.length === 1, 'the timeout')
    expect(peer.closes).toEqual(['handshake_timeout'])
  })

  test('a malformed hello is fatal', async () => {
    const peer = await rawPeer()
    peer.socket.write('tb2-hello not-a-nonce\n')
    await until(() => peer.closes.length === 1, 'the close')
    expect(peer.closes).toEqual(['malformed'])
  })
})

describe('HubServer and HubClient', () => {
  interface Harness {
    readonly events: unknown[]
    readonly registrations: unknown[]
    channel: SpokeChannel | undefined
    readonly closed: string[]
    client: HubClient
    server: HubServer
  }

  function harness(
    answer: (channel: SpokeChannel) => RegistrationAnswer,
    options: { secret?: Uint8Array; session?: string } = {},
  ): Harness {
    const h: Partial<Harness> & { events: unknown[]; registrations: unknown[]; closed: string[] } =
      {
        events: [],
        registrations: [],
        closed: [],
        channel: undefined,
      }
    const server = new HubServer({
      endpoint: hubEndpoint(dir),
      secret: SECRET,
      logger,
      onRegister: async (registration, channel) => {
        h.registrations.push(registration)
        h.channel = channel
        return answer(channel)
      },
    })
    const client = new HubClient({
      endpoint: hubEndpoint(dir),
      secret: () => options.secret ?? SECRET,
      session: options.session ?? 's1',
      projectDir: '/p/app',
      projectName: 'app',
      logger,
      onEvent: (event) => h.events.push(event),
      onRegistered: () => {},
      onDisconnected: () => h.closed.push('disconnected'),
      initialRetryMs: 10,
      maxRetryMs: 40,
      requestTimeoutMs: 2_000,
    })
    cleanups.push(async () => {
      await client.stop()
      await server.stop()
    })
    return Object.assign(h, { client, server }) as Harness
  }

  const ok = (handle: (request: HubRequest) => Promise<unknown>) => (): RegistrationAnswer => ({
    ok: true,
    topicId: '7',
    topicName: 'app',
    endedSessions: ['old'],
    handle,
    closed: () => {},
  })

  test('a spoke registers, sends requests, and receives events', async () => {
    const seen: unknown[] = []
    const h = harness(
      ok(async (request) => {
        seen.push(request)
        return { parts: 1, redactions: 0 }
      }),
    )
    expect(await h.server.start()).toBe('listening')
    h.client.start()
    await until(() => h.client.registration !== undefined, 'the registration')
    expect(h.client.registration).toEqual({
      topicId: '7',
      topicName: 'app',
      endedSessions: ['old'],
    })
    expect(h.registrations).toEqual([{ session: 's1', projectDir: '/p/app', projectName: 'app' }])

    expect(await h.client.request({ op: 'sendText', chatId: '1', text: 'hi' })).toEqual({
      parts: 1,
      redactions: 0,
    })
    expect(seen).toEqual([{ op: 'sendText', chatId: '1', text: 'hi' }])

    expect(h.channel?.deliver({ kind: 'brake', sender: ALICE })).toBe(true)
    await until(() => h.events.length === 1, 'the event')
    expect(h.events).toEqual([{ t: 'brake', sender: ALICE }])
  })

  test('hub errors come back typed; a refused request is not a crash', async () => {
    const h = harness(
      ok(async (request) => {
        if (request.op === 'editStatus') throw new StatusFloodWaitError(1500)
        throw new SpokeRequestRefusedError('not yours')
      }),
    )
    await h.server.start()
    h.client.start()
    await until(() => h.client.registration !== undefined, 'the registration')
    const flood = await h.client
      .request({ op: 'editStatus', ref: { chatId: '1', messageId: '2' }, text: 'x' })
      .catch((error: unknown) => error)
    expect(flood).toBeInstanceOf(HubRequestError)
    expect(flood).toMatchObject({ kind: 'status_flood', retryAfterMs: 1500 })
    const refused = await h.client
      .request({ op: 'sendText', chatId: '1', text: 'x' })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({ kind: 'refused' })
    // The connection is still up.
    expect(h.client.registration).toBeDefined()
  })

  test('a spoke with the wrong key never registers', async () => {
    const h = harness(
      ok(async () => null),
      { secret: randomBytes(32) },
    )
    await h.server.start()
    h.client.start()
    await until(() => logger.text.includes('unauthenticated'), 'the drop')
    expect(h.registrations).toEqual([])
    expect(h.client.registration).toBeUndefined()
    await expect(h.client.request({ op: 'typing', chatId: '1' })).rejects.toBeInstanceOf(
      HubUnavailableError,
    )
  })

  test('a refused registration is reported, and the spoke keeps retrying', async () => {
    let refuse = true
    const h = harness(() => (refuse ? { ok: false, reason: 'failed' } : ok(async () => null)()))
    await h.server.start()
    h.client.start()
    await until(() => h.registrations.length >= 1, 'the first attempt')
    expect(h.client.registration).toBeUndefined()
    refuse = false
    await until(() => h.client.registration !== undefined, 'the registration')
    expect(logger.text).toContain('the hub refused this session')
  })

  test('without a hub the spoke says how to start one; it connects once the hub is up', async () => {
    const h = harness(ok(async () => 'pong'))
    h.client.start()
    const error = await h.client.request({ op: 'typing', chatId: '1' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HubUnavailableError)
    expect(String((error as Error).message)).toContain('bun run bridge -- hub run')
    await h.server.start()
    await until(() => h.client.registration !== undefined, 'the late registration')

    await h.server.stop()
    await until(() => h.client.registration === undefined, 'the disconnect')
    expect(h.closed).toContain('disconnected')
    await h.server.start()
    await until(() => h.client.registration !== undefined, 'the reconnection')
    expect(h.registrations).toHaveLength(2)
  })

  test('a frame that is not a register first is cut off', async () => {
    const h = harness(ok(async () => null))
    await h.server.start()
    const link = await new Promise<HubLink>((resolve) => {
      const socket = connect(hubEndpoint(dir).path)
      const l = new HubLink(socket, {
        secret: SECRET,
        role: 'client',
        onFrame: () => {},
        onClose: () => {},
      })
      void l.ready.then(() => resolve(l))
    })
    cleanups.push(() => link.close())
    link.send({ t: 'req', id: 1, request: { op: 'typing', chatId: '1' } })
    await until(() => !link.isOpen, 'the cut')
    expect(h.registrations).toEqual([])
  })
})
