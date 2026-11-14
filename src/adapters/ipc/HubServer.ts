import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import type { SpokeChannel, SpokeEvent } from '../../application/hub/HubRegistry.ts'
import { SpokeRequestRefusedError } from '../../application/hub/TopicBoundGateway.ts'
import type { HookListenResult } from '../../application/ports/HookEventSource.ts'
import type { Logger } from '../../application/ports/Logger.ts'
import {
  StatusFloodWaitError,
  StatusMessageGoneError,
} from '../../application/ports/StatusMessageGateway.ts'
import { EventThrottle } from '../../domain/EventThrottle.ts'
import { SECRET_FILE_MODE } from '../storage/stateDir.ts'
import type { HookEndpoint } from './endpoint.ts'
import { isStaleSocket } from './HookIpcServer.ts'
import { HubLink, type HubLinkClose } from './HubLink.ts'
import {
  HUB_PROTOCOL_VERSION,
  type HubErrorKind,
  type HubFrame,
  type HubRequest,
  SpokeFrame,
} from './hubProtocol.ts'
import { ensurePrivateDir } from './privateDir.ts'

/** A spoke that has not registered by then is cut off. */
export const REGISTER_TIMEOUT_MS = 5_000

/** Requests of one spoke handled at once at most; more are refused at once. */
export const MAX_REQUESTS_IN_FLIGHT = 64

/** Connections at most (spokes plus anything still in its handshake). */
export const MAX_CONNECTIONS = 64

export interface SpokeRegistration {
  readonly session: string
  readonly projectDir: string
  readonly projectName: string | undefined
}

export type RegistrationAnswer =
  | {
      readonly ok: true
      readonly topicId: string
      readonly topicName: string
      readonly endedSessions: readonly string[]
      /** Requests of this connection, already bound to its session and topic. */
      readonly handle: (request: HubRequest) => Promise<unknown>
      /** The connection closed. */
      readonly closed: () => void
    }
  | { readonly ok: false; readonly reason: 'not_configured' | 'invalid' | 'failed' }

export interface HubServerOptions {
  readonly endpoint: HookEndpoint
  readonly secret: Uint8Array
  readonly logger: Logger
  /** A spoke registered; `channel` is how the hub pushes events to it. */
  readonly onRegister: (
    registration: SpokeRegistration,
    channel: SpokeChannel,
  ) => Promise<RegistrationAnswer>
  readonly now?: () => number
}

/**
 * The hub's listener (F14): a Unix socket (0600, in a 0700 directory) or a
 * Windows named pipe, never TCP. Each connection is a `HubLink`; its first
 * frame must be a `register` of the current protocol version, after which
 * it is bound to the session and topic the hub assigned, for its whole life.
 */
export class HubServer {
  readonly #o: HubServerOptions
  readonly #sockets = new Set<Socket>()
  readonly #links = new Set<HubLink>()
  readonly #dropLog = new EventThrottle(60_000)
  #server: Server | undefined
  #socketIno: number | undefined

  constructor(options: HubServerOptions) {
    this.#o = options
  }

  get address(): ReturnType<Server['address']> {
    return this.#server?.address() ?? null
  }

  async start(): Promise<HookListenResult> {
    if (this.#server !== undefined) return 'listening'
    const endpoint = this.#o.endpoint
    if (endpoint.kind === 'unix' && endpoint.privateDir !== undefined) {
      if (!ensurePrivateDir(endpoint.privateDir)) {
        this.#o.logger.error('the hub socket directory is not private', {
          dir: endpoint.privateDir,
        })
        return 'failed'
      }
    }
    let result = await this.#listen()
    if (result === 'in_use' && endpoint.kind === 'unix' && (await isStaleSocket(endpoint.path))) {
      unlinkSync(endpoint.path)
      result = await this.#listen()
    }
    if (result === 'listening' && endpoint.kind === 'unix') {
      chmodSync(endpoint.path, SECRET_FILE_MODE)
      this.#socketIno = lstatSync(endpoint.path).ino
    }
    if (result === 'listening') this.#o.logger.info('the hub listens for sessions')
    return result
  }

  /** Closes every spoke connection (they reconnect to the next hub) and stops listening. */
  async stop(): Promise<void> {
    const server = this.#server
    if (server === undefined) return
    this.#server = undefined
    for (const link of this.#links) link.close()
    for (const socket of this.#sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const endpoint = this.#o.endpoint
    if (endpoint.kind === 'unix' && this.#socketIno !== undefined) {
      try {
        if (lstatSync(endpoint.path).ino === this.#socketIno) unlinkSync(endpoint.path)
      } catch {
        // Already gone.
      }
      this.#socketIno = undefined
    }
  }

  #listen(): Promise<HookListenResult> {
    return new Promise((resolve) => {
      const server = createServer((socket) => this.#onConnection(socket))
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') return resolve('in_use')
        this.#o.logger.error('the hub could not listen', { error })
        resolve('failed')
      })
      server.listen(this.#o.endpoint.path, () => {
        server.removeAllListeners('error')
        server.on('error', (error) => this.#o.logger.error('hub listener error', { error }))
        this.#server = server
        resolve('listening')
      })
    })
  }

  #onConnection(socket: Socket): void {
    if (this.#sockets.size >= MAX_CONNECTIONS) {
      socket.destroy()
      this.#drop('too_many_connections')
      return
    }
    this.#sockets.add(socket)
    socket.on('close', () => this.#sockets.delete(socket))
    new SpokeConnection(socket, this.#o, {
      added: (link) => this.#links.add(link),
      removed: (link) => this.#links.delete(link),
      dropped: (reason) => this.#drop(reason),
    })
  }

  #drop(reason: string): void {
    const decision = this.#dropLog.record(reason, (this.#o.now ?? Date.now)())
    if (decision.emit) {
      this.#o.logger.warn('the hub dropped a connection', {
        reason,
        suppressed: decision.suppressed,
      })
    }
  }
}

interface ConnectionHooks {
  added(link: HubLink): void
  removed(link: HubLink): void
  dropped(reason: string): void
}

/** One spoke: registration, then requests and pushed events. */
class SpokeConnection implements SpokeChannel {
  readonly #link: HubLink
  readonly #o: HubServerOptions
  readonly #hooks: ConnectionHooks
  #answer: Extract<RegistrationAnswer, { ok: true }> | undefined
  #registering = false
  #inFlight = 0
  readonly #registerTimer: ReturnType<typeof setTimeout>

  constructor(socket: Socket, options: HubServerOptions, hooks: ConnectionHooks) {
    this.#o = options
    this.#hooks = hooks
    this.#link = new HubLink(socket, {
      secret: options.secret,
      role: 'server',
      onFrame: (frame) => this.#onFrame(frame),
      onClose: (reason) => this.#onClose(reason),
    })
    hooks.added(this.#link)
    this.#registerTimer = setTimeout(() => {
      if (this.#answer === undefined) {
        hooks.dropped('no_registration')
        this.#link.close()
      }
    }, REGISTER_TIMEOUT_MS)
  }

  deliver(event: SpokeEvent): boolean {
    if (this.#answer === undefined) return false
    return this.#link.send(toFrame(event))
  }

  close(): void {
    this.#link.close()
  }

  #onFrame(raw: unknown): void {
    const parsed = SpokeFrame.safeParse(raw)
    if (!parsed.success) {
      this.#hooks.dropped('malformed_frame')
      // Before registration nothing is trusted yet: cut it off.
      if (this.#answer === undefined) this.#link.close()
      else if (isRequestWithId(raw)) this.#error(raw.id, 'refused', 'malformed request')
      return
    }
    const frame = parsed.data
    if (frame.t === 'register') return void this.#register(frame)
    if (this.#answer === undefined) {
      this.#hooks.dropped('request_before_registration')
      this.#link.close()
      return
    }
    void this.#handle(frame.id, frame.request)
  }

  async #register(frame: Extract<SpokeFrame, { t: 'register' }>): Promise<void> {
    if (this.#registering || this.#answer !== undefined) {
      this.#hooks.dropped('second_registration')
      this.#link.close()
      return
    }
    this.#registering = true
    if (frame.v !== HUB_PROTOCOL_VERSION) {
      this.#o.logger.warn('a session speaks another hub protocol version; refused', {
        spoke: frame.v,
        hub: HUB_PROTOCOL_VERSION,
      })
      this.#link.send({ t: 'refused', reason: 'version' } satisfies HubFrame)
      this.#link.close()
      return
    }
    const answer = await this.#o.onRegister(
      { session: frame.session, projectDir: frame.projectDir, projectName: frame.projectName },
      this,
    )
    clearTimeout(this.#registerTimer)
    if (!answer.ok) {
      this.#link.send({ t: 'refused', reason: answer.reason } satisfies HubFrame)
      this.#link.close()
      return
    }
    if (!this.#link.isOpen) {
      // It went away while the hub was assigning its topic.
      return answer.closed()
    }
    this.#answer = answer
    this.#link.send({
      t: 'registered',
      v: HUB_PROTOCOL_VERSION,
      topicId: answer.topicId,
      topicName: answer.topicName,
      endedSessions: [...answer.endedSessions],
    } satisfies HubFrame)
  }

  async #handle(id: number, request: HubRequest): Promise<void> {
    const answer = this.#answer
    if (answer === undefined) return
    if (this.#inFlight >= MAX_REQUESTS_IN_FLIGHT) {
      this.#error(id, 'unavailable', 'the hub is busy with this session; try again')
      return
    }
    this.#inFlight += 1
    try {
      const value = await answer.handle(request)
      this.#link.send({ t: 'res', id, value: value ?? null } satisfies HubFrame)
    } catch (error) {
      if (error instanceof StatusFloodWaitError) {
        this.#error(id, 'status_flood', error.message, error.retryAfterMs)
      } else if (error instanceof StatusMessageGoneError) {
        this.#error(id, 'status_gone', error.message)
      } else if (error instanceof SpokeRequestRefusedError) {
        this.#hooks.dropped('refused_request')
        this.#error(id, 'refused', error.message)
      } else {
        this.#error(id, 'failed', error instanceof Error ? error.message : String(error))
      }
    } finally {
      this.#inFlight -= 1
    }
  }

  #error(id: number, kind: HubErrorKind, message: string, retryAfterMs?: number): void {
    this.#link.send({
      t: 'err',
      id,
      kind,
      message: message.slice(0, 1024),
      ...(retryAfterMs === undefined
        ? {}
        : { retryAfterMs: Math.max(0, Math.round(retryAfterMs)) }),
    } satisfies HubFrame)
  }

  #onClose(reason: HubLinkClose): void {
    clearTimeout(this.#registerTimer)
    this.#hooks.removed(this.#link)
    if (reason !== 'closed') this.#hooks.dropped(reason)
    const answer = this.#answer
    this.#answer = undefined
    answer?.closed()
  }
}

function isRequestWithId(raw: unknown): raw is { id: number } {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { t?: unknown }).t === 'req' &&
    Number.isSafeInteger((raw as { id?: unknown }).id)
  )
}

function toFrame(event: SpokeEvent): HubFrame {
  switch (event.kind) {
    case 'message':
      return {
        t: 'message',
        message: event.message as Extract<HubFrame, { t: 'message' }>['message'],
      }
    case 'tap':
      return { t: 'tap', callback: event.callback as Extract<HubFrame, { t: 'tap' }>['callback'] }
    case 'hook':
      return { t: 'hook', payload: event.payload }
    case 'brake':
      return { t: 'brake', sender: event.sender }
  }
}
