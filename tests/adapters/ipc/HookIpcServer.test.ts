/**
 * The hook listener over a real transport: a named pipe on Windows, a Unix
 * socket elsewhere. POSIX-only checks are skipped on win32 and run on CI's
 * ubuntu.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { type HookEndpoint, hookEndpoint } from '../../../src/adapters/ipc/endpoint.ts'
import { encodeFrame } from '../../../src/adapters/ipc/frame.ts'
import {
  HookIpcServer,
  type HookIpcServerOptions,
} from '../../../src/adapters/ipc/HookIpcServer.ts'
import { sendHookFrame } from '../../../src/adapters/ipc/hookClient.ts'
import { MemoryLogger } from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

const posixOnly = test.skipIf(process.platform === 'win32')
const SECRET = new Uint8Array(32).fill(1)
const WRONG = new Uint8Array(32).fill(2)

let stateDir: string
let endpoint: HookEndpoint
let logger: MemoryLogger
const servers: HookIpcServer[] = []

beforeEach(() => {
  stateDir = makeTempDir()
  endpoint = hookEndpoint(stateDir)
  logger = new MemoryLogger()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  removeTempDir(stateDir)
})

function server(overrides: Partial<HookIpcServerOptions> = {}): HookIpcServer {
  const created = new HookIpcServer({ endpoint, secret: SECRET, logger, ...overrides })
  servers.push(created)
  return created
}

/** Collects the payloads handed to the handler. */
function recorder() {
  const payloads: unknown[] = []
  return {
    payloads,
    handler: async (payload: unknown) => {
      payloads.push(payload)
    },
  }
}

const frame = (payload: unknown, secret = SECRET) => encodeFrame(secret, JSON.stringify(payload))

async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !probe(); i++) await Bun.sleep(2)
  if (!probe()) throw new Error(`timed out waiting for ${what}`)
}

/** Writes raw bytes and resolves with whatever came back once the server closes. */
function raw(data: string, keepOpen = false): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(endpoint.path)
    let got = ''
    socket.on('connect', () => (keepOpen ? socket.write(data) : socket.end(data)))
    socket.on('data', (chunk) => {
      got += chunk.toString()
    })
    socket.on('error', () => {})
    socket.on('close', () => resolve(got))
  })
}

test('an authentic frame is acknowledged and handed to the handler', async () => {
  const rec = recorder()
  expect(await server().start(rec.handler)).toBe('listening')
  const payload = { hook_event_name: 'Stop', last_assistant_message: 'done' }
  expect(await sendHookFrame(endpoint, frame(payload), 1_000)).toBe('acked')
  await until(() => rec.payloads.length === 1, 'the payload')
  expect(rec.payloads).toEqual([payload])
})

test('never a network socket: the bound address is a path, not a host and port', async () => {
  const listener = server()
  await listener.start(recorder().handler)
  expect(typeof listener.address).toBe('string')
  expect(listener.address).toBe(endpoint.path)
  expect(endpoint.path).not.toMatch(/^\d|:\d+$/)
})

test('a wrong secret is dropped and counted, and its content is never logged', async () => {
  const rec = recorder()
  const listener = server()
  await listener.start(rec.handler)
  const secretText = 'TOP-SECRET-last-message'
  expect(await sendHookFrame(endpoint, frame({ x: secretText }, WRONG), 1_000)).toBe('no_ack')
  expect(await raw('this is not a frame at all\n')).toBe('')
  await until(() => listener.dropped('unauthenticated') === 2, 'both drops')
  expect(rec.payloads).toEqual([])
  expect(logger.text).toContain('dropped a hook message')
  expect(logger.text).not.toContain(secretText)
  // Throttled: one line per reason per minute, however many drops.
  expect(logger.entries.filter((e) => e.message === 'dropped a hook message')).toHaveLength(1)
})

test('authentic but not JSON is dropped as malformed', async () => {
  const listener = server()
  await listener.start(recorder().handler)
  expect(await raw(encodeFrame(SECRET, '{not json'))).toBe('')
  await until(() => listener.dropped('malformed') === 1, 'the drop')
})

test('an oversize frame is cut off before it is read to the end', async () => {
  const rec = recorder()
  const listener = server({ maxFrameBytes: 1024 })
  await listener.start(rec.handler)
  const big = frame({ text: 'x'.repeat(5_000) })
  expect(await sendHookFrame(endpoint, big, 1_000)).not.toBe('acked')
  await until(() => listener.dropped('oversize') === 1, 'the drop')
  // A frame just under the cap still goes through.
  expect(await sendHookFrame(endpoint, frame({ text: 'x'.repeat(800) }), 1_000)).toBe('acked')
  expect(rec.payloads).toHaveLength(1)
})

test('a slow client that never finishes its frame is disconnected', async () => {
  const listener = server({ readTimeoutMs: 50 })
  await listener.start(recorder().handler)
  expect(await raw('tb1 partial-frame-without-newline', true)).toBe('')
  expect(listener.dropped('timeout')).toBe(1)
})

test('concurrent clients: every frame arrives, handled one at a time', async () => {
  let running = 0
  let maxRunning = 0
  const seen: number[] = []
  await server().start(async (payload) => {
    running += 1
    maxRunning = Math.max(maxRunning, running)
    await Bun.sleep(1)
    seen.push((payload as { n: number }).n)
    running -= 1
  })
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, (_, n) => sendHookFrame(endpoint, frame({ n }), 2_000)),
  )
  expect(outcomes.every((o) => o === 'acked')).toBe(true)
  await until(() => seen.length === 20, 'all frames')
  expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n))
  expect(maxRunning).toBe(1)
})

test('beyond the pending bound new events are dropped, not queued', async () => {
  let release: () => void = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const listener = server({ maxPending: 1 })
  await listener.start(() => blocked)
  expect(await sendHookFrame(endpoint, frame({ n: 1 }), 1_000)).toBe('acked')
  expect(await sendHookFrame(endpoint, frame({ n: 2 }), 1_000)).toBe('no_ack')
  expect(listener.dropped('overloaded')).toBe(1)
  release()
})

test('a handler failure is logged and does not stop the listener', async () => {
  const listener = server()
  let calls = 0
  await listener.start(async () => {
    calls += 1
    throw new Error('boom')
  })
  await sendHookFrame(endpoint, frame({}), 1_000)
  expect(await sendHookFrame(endpoint, frame({}), 1_000)).toBe('acked')
  await until(() => calls === 2, 'both calls')
  expect(logger.text).toContain('handling a hook event failed')
})

test('a second listener on the same endpoint is refused while the first is alive', async () => {
  await server().start(recorder().handler)
  expect(await server().start(recorder().handler)).toBe('in_use')
})

test('after stop nobody answers, and the client gives up at once', async () => {
  const listener = server()
  await listener.start(recorder().handler)
  await listener.stop()
  const started = performance.now()
  expect(await sendHookFrame(endpoint, frame({}), 1_000)).toBe('unreachable')
  expect(performance.now() - started).toBeLessThan(500)
  // It can listen again.
  expect(await listener.start(recorder().handler)).toBe('listening')
})

describe('POSIX socket file', () => {
  posixOnly('is 0600 while listening and removed on stop', async () => {
    const listener = server()
    await listener.start(recorder().handler)
    expect(statSync(endpoint.path).mode & 0o777).toBe(0o600)
    await listener.stop()
    expect(existsSync(endpoint.path)).toBe(false)
  })

  posixOnly('a stale socket of a dead process is replaced', async () => {
    // A child binds the socket and dies without closing it.
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `require('node:net').createServer().listen(${JSON.stringify(endpoint.path)}, () => process.exit(0))`,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    await child.exited
    expect(existsSync(endpoint.path)).toBe(true)
    const rec = recorder()
    expect(await server().start(rec.handler)).toBe('listening')
    expect(await sendHookFrame(endpoint, frame({ ok: true }), 1_000)).toBe('acked')
  })

  posixOnly('a long state directory uses a private fallback directory', async () => {
    const longState = join(stateDir, 'x'.repeat(120))
    mkdirSync(longState)
    const tmpDir = join(stateDir, 'tmp')
    mkdirSync(tmpDir)
    endpoint = hookEndpoint(longState, { platform: process.platform, env: {}, tmpDir })
    expect(endpoint.kind === 'unix' && endpoint.privateDir !== undefined).toBe(true)
    const listener = server()
    expect(await listener.start(recorder().handler)).toBe('listening')
    if (endpoint.kind !== 'unix' || endpoint.privateDir === undefined) return
    expect(statSync(endpoint.privateDir).mode & 0o777).toBe(0o700)
    expect(await sendHookFrame(endpoint, frame({}), 1_000)).toBe('acked')
    await listener.stop()

    // Someone else could have made it readable: then neither side uses it.
    chmodSync(endpoint.privateDir, 0o755)
    expect(await server().start(recorder().handler)).toBe('failed')
    expect(await sendHookFrame(endpoint, frame({}), 1_000)).toBe('unreachable')
  })
})
