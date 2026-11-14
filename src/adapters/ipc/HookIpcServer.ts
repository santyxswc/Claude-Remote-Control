import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import type {
  HookEventSource,
  HookListenResult,
  HookPayloadHandler,
} from '../../application/ports/HookEventSource.ts'
import type { Logger } from '../../application/ports/Logger.ts'
import { EventThrottle } from '../../domain/EventThrottle.ts'
import { SECRET_FILE_MODE } from '../storage/stateDir.ts'
import type { HookEndpoint } from './endpoint.ts'
import { ACK, MAX_FRAME_BYTES, verifyFrame } from './frame.ts'
import { ensurePrivateDir } from './privateDir.ts'

/** A client that has not sent a whole frame by then is cut off. */
export const READ_TIMEOUT_MS = 2_000

/** Events waiting for the use cases; beyond this new ones are dropped. */
export const MAX_PENDING_EVENTS = 64

/** How long a stale socket gets to answer before it is considered dead. */
const PROBE_TIMEOUT_MS = 300

const DROP_LOG_WINDOW_MS = 60_000

export type DropReason = 'unauthenticated' | 'oversize' | 'malformed' | 'timeout' | 'overloaded'

export interface HookIpcServerOptions {
  readonly endpoint: HookEndpoint
  readonly secret: Uint8Array
  readonly logger: Logger
  /** Test seams. */
  readonly maxFrameBytes?: number
  readonly readTimeoutMs?: number
  readonly maxPending?: number
  readonly now?: () => number
}

/**
 * Listens for hook events on a Unix socket (0600, in a 0700 directory) or a
 * Windows named pipe. Each connection carries one newline-terminated frame,
 * size-capped and authenticated with the shared secret; an accepted frame
 * is acknowledged and the connection closed. Rejected frames are counted
 * and logged by reason only, never their content. Events reach the handler
 * one at a time, in arrival order.
 */
export class HookIpcServer implements HookEventSource {
  readonly #o: HookIpcServerOptions
  readonly #sockets = new Set<Socket>()
  readonly #dropLog = new EventThrottle(DROP_LOG_WINDOW_MS)
  readonly #dropped = new Map<DropReason, number>()
  #server: Server | undefined
  #socketIno: number | undefined
  #queue: Promise<void> = Promise.resolve()
  #pending = 0
  #accepted = 0

  constructor(options: HookIpcServerOptions) {
    this.#o = options
  }

  get accepted(): number {
    return this.#accepted
  }

  dropped(reason: DropReason): number {
    return this.#dropped.get(reason) ?? 0
  }

  /** The address actually bound (a path), for tests that assert it is not TCP. */
  get address(): ReturnType<Server['address']> {
    return this.#server?.address() ?? null
  }

  async start(handler: HookPayloadHandler): Promise<HookListenResult> {
    if (this.#server !== undefined) return 'listening'
    const endpoint = this.#o.endpoint
    if (endpoint.kind === 'unix' && endpoint.privateDir !== undefined) {
      if (!ensurePrivateDir(endpoint.privateDir)) {
        this.#o.logger.error('the hook socket directory is not private; hooks are off', {
          dir: endpoint.privateDir,
        })
        return 'failed'
      }
    }
    let result = await this.#listen(handler)
    if (result === 'in_use' && endpoint.kind === 'unix' && (await isStaleSocket(endpoint.path))) {
      // A crashed process left its socket behind and nobody answers on it.
      unlinkSync(endpoint.path)
      result = await this.#listen(handler)
    }
    if (result === 'listening' && endpoint.kind === 'unix') {
      chmodSync(endpoint.path, SECRET_FILE_MODE)
      this.#socketIno = lstatSync(endpoint.path).ino
    }
    if (result === 'listening') this.#o.logger.info('listening for hook events')
    return result
  }

  async stop(): Promise<void> {
    const server = this.#server
    if (server === undefined) return
    this.#server = undefined
    for (const socket of this.#sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.#removeOwnSocketFile()
    await this.#queue
  }

  #listen(handler: HookPayloadHandler): Promise<HookListenResult> {
    return new Promise((resolve) => {
      const server = createServer((socket) => this.#onConnection(socket, handler))
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') return resolve('in_use')
        this.#o.logger.error('could not listen for hook events', { error })
        resolve('failed')
      })
      server.listen(this.#o.endpoint.path, () => {
        server.removeAllListeners('error')
        server.on('error', (error) => this.#o.logger.error('hook listener error', { error }))
        this.#server = server
        resolve('listening')
      })
    })
  }

  #onConnection(socket: Socket, handler: HookPayloadHandler): void {
    const maxBytes = this.#o.maxFrameBytes ?? MAX_FRAME_BYTES
    this.#sockets.add(socket)
    socket.on('close', () => this.#sockets.delete(socket))
    socket.on('error', () => socket.destroy()) // a client that resets is not our problem
    socket.setTimeout(this.#o.readTimeoutMs ?? READ_TIMEOUT_MS, () => this.#drop(socket, 'timeout'))
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer): void => {
      const newline = chunk.indexOf(0x0a)
      const take = newline < 0 ? chunk : chunk.subarray(0, newline)
      size += take.length
      if (size >= maxBytes) {
        this.#drop(socket, 'oversize')
        return
      }
      chunks.push(take)
      if (newline < 0) return
      socket.off('data', onData)
      socket.setTimeout(0)
      this.#accept(socket, Buffer.concat(chunks).toString('utf8'), handler)
    }
    socket.on('data', onData)
  }

  #accept(socket: Socket, line: string, handler: HookPayloadHandler): void {
    const frame = this.#open(line)
    if (!frame.ok) {
      this.#drop(socket, frame.reason)
      return
    }
    const { payload } = frame
    socket.end(ACK)
    this.#accepted += 1
    this.#pending += 1
    this.#queue = this.#queue
      .then(() => handler(payload))
      .catch((error: unknown) => this.#o.logger.error('handling a hook event failed', { error }))
      .finally(() => {
        this.#pending -= 1
      })
  }

  #open(line: string): { ok: true; payload: unknown } | { ok: false; reason: DropReason } {
    const json = verifyFrame(this.#o.secret, line)
    if (json === undefined) return { ok: false, reason: 'unauthenticated' }
    if (this.#pending >= (this.#o.maxPending ?? MAX_PENDING_EVENTS)) {
      return { ok: false, reason: 'overloaded' }
    }
    try {
      return { ok: true, payload: JSON.parse(json) }
    } catch {
      return { ok: false, reason: 'malformed' }
    }
  }

  #drop(socket: Socket, reason: DropReason): void {
    socket.destroy()
    this.#dropped.set(reason, this.dropped(reason) + 1)
    const decision = this.#dropLog.record(reason, (this.#o.now ?? Date.now)())
    if (decision.emit) {
      this.#o.logger.warn('dropped a hook message', { reason, suppressed: decision.suppressed })
    }
  }

  /** Only the file we bound: never one a newer listener created after us. */
  #removeOwnSocketFile(): void {
    const endpoint = this.#o.endpoint
    if (endpoint.kind !== 'unix' || this.#socketIno === undefined) return
    try {
      if (lstatSync(endpoint.path).ino === this.#socketIno) unlinkSync(endpoint.path)
    } catch {
      // Already gone.
    }
    this.#socketIno = undefined
  }
}

/** True only for a socket file nobody answers on; anything else is left alone. */
export async function isStaleSocket(path: string): Promise<boolean> {
  try {
    if (!lstatSync(path).isSocket()) return false
  } catch {
    return false
  }
  return new Promise((resolve) => {
    const probe = connect(path)
    const finish = (stale: boolean): void => {
      clearTimeout(timer)
      probe.destroy()
      resolve(stale)
    }
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS)
    probe.once('connect', () => finish(false))
    probe.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'),
    )
  })
}
