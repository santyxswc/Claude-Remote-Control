import { connect, type Socket } from 'node:net'
import type { Logger } from '../../application/ports/Logger.ts'
import type { HookEndpoint } from './endpoint.ts'
import { HubLink, type HubLinkClose } from './HubLink.ts'
import {
  HUB_PROTOCOL_VERSION,
  type HubErrorKind,
  HubFrame,
  type HubRequest,
} from './hubProtocol.ts'
import { isPrivateDir } from './privateDir.ts'

/** The hub is not running, not reachable, or this spoke is not registered (yet). */
export class HubUnavailableError extends Error {
  constructor(detail = 'not connected') {
    super(
      `the telegram-bridge hub is not reachable (${detail}); start it with \`bun run bridge -- hub run\``,
    )
    this.name = 'HubUnavailableError'
  }
}

/** The hub answered a request with an error. */
export class HubRequestError extends Error {
  constructor(
    readonly kind: HubErrorKind,
    message: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message)
    this.name = 'HubRequestError'
  }
}

export type HubEvent = Extract<HubFrame, { t: 'message' | 'tap' | 'hook' | 'brake' }>

export interface HubRegistration {
  readonly topicId: string
  readonly topicName: string
  readonly endedSessions: readonly string[]
}

export interface HubClientOptions {
  readonly endpoint: HookEndpoint
  /** Read at each attempt: the hub creates it on its first start. */
  readonly secret: () => Uint8Array | undefined
  readonly session: string
  readonly projectDir: string
  readonly projectName: string | undefined
  readonly logger: Logger
  readonly onEvent: (event: HubEvent) => void
  readonly onRegistered: (registration: HubRegistration) => void
  readonly onDisconnected: () => void
  /** Reconnect backoff. */
  readonly initialRetryMs?: number
  readonly maxRetryMs?: number
  readonly requestTimeoutMs?: number
}

const DEFAULT_INITIAL_RETRY_MS = 500
const DEFAULT_MAX_RETRY_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Requests waiting for the hub at most; beyond, new ones fail at once. */
const MAX_PENDING_REQUESTS = 256

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * A spoke's connection to the hub (F14): connect, register, reconnect with
 * backoff when the hub goes away (pending requests fail at once with
 * `HubUnavailableError`), and register again with the same session id, so
 * the hub gives the same topic back. Never TCP.
 */
export class HubClient {
  readonly #o: HubClientOptions
  readonly #pending = new Map<number, Pending>()
  #link: HubLink | undefined
  #registration: HubRegistration | undefined
  #nextId = 1
  #retryMs: number
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #stopped = true
  #lastProblem: string | undefined

  constructor(options: HubClientOptions) {
    this.#o = options
    this.#retryMs = options.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS
  }

  get registration(): HubRegistration | undefined {
    return this.#registration
  }

  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    this.#attempt()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#retryTimer)
    this.#link?.close()
    this.#link = undefined
    this.#failPending(new HubUnavailableError('stopping'))
  }

  /** One request; resolves with the hub's value or rejects (`HubRequestError`, `HubUnavailableError`). */
  request(request: HubRequest, timeoutMs?: number): Promise<unknown> {
    const link = this.#link
    if (link === undefined || this.#registration === undefined) {
      return Promise.reject(new HubUnavailableError(this.#lastProblem))
    }
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new HubUnavailableError('too many requests in flight'))
    }
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(id)
          reject(new HubUnavailableError('the request timed out'))
        },
        timeoutMs ?? this.#o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      )
      this.#pending.set(id, { resolve, reject, timer })
      if (!link.send({ t: 'req', id, request })) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new HubUnavailableError('the request could not be sent'))
      }
    })
  }

  #attempt(): void {
    if (this.#stopped) return
    const secret = this.#o.secret()
    const endpoint = this.#o.endpoint
    if (secret === undefined) {
      this.#retry('no hub key yet')
      return
    }
    if (endpoint.kind === 'unix' && endpoint.privateDir !== undefined) {
      if (!isPrivateDir(endpoint.privateDir)) {
        this.#retry('the socket directory is not private')
        return
      }
    }
    let socket: Socket
    try {
      socket = connect(endpoint.path)
    } catch {
      this.#retry('cannot connect')
      return
    }
    let opened = false
    socket.once('connect', () => {
      opened = true
    })
    socket.once('error', () => {
      if (!opened) this.#retry('the hub is not running')
    })
    const link = new HubLink(socket, {
      secret,
      role: 'client',
      onFrame: (frame) => this.#onFrame(link, frame),
      onClose: (reason) => this.#onClose(link, reason, opened),
    })
    this.#link = link
    void link.ready.then((ok) => {
      if (!ok || this.#link !== link) return
      link.send({
        t: 'register',
        v: HUB_PROTOCOL_VERSION,
        session: this.#o.session,
        projectDir: this.#o.projectDir,
        ...(this.#o.projectName === undefined ? {} : { projectName: this.#o.projectName }),
      })
    })
  }

  #onFrame(link: HubLink, raw: unknown): void {
    const parsed = HubFrame.safeParse(raw)
    if (!parsed.success) {
      this.#o.logger.warn('dropped a malformed frame from the hub', {
        type: typeof raw === 'object' && raw !== null ? String((raw as { t?: unknown }).t) : null,
      })
      return
    }
    const frame = parsed.data
    switch (frame.t) {
      case 'registered': {
        if (frame.v !== HUB_PROTOCOL_VERSION) {
          this.#o.logger.error('the hub speaks another protocol version; update both', {
            hub: frame.v,
            spoke: HUB_PROTOCOL_VERSION,
          })
          link.close()
          return
        }
        this.#retryMs = this.#o.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS
        this.#lastProblem = undefined
        this.#registration = {
          topicId: frame.topicId,
          topicName: frame.topicName,
          endedSessions: frame.endedSessions,
        }
        this.#o.logger.info('registered with the hub', { topicId: frame.topicId })
        this.#o.onRegistered(this.#registration)
        return
      }
      case 'refused':
        this.#lastProblem = `refused: ${frame.reason}`
        this.#o.logger.error('the hub refused this session', { reason: frame.reason })
        link.close()
        return
      case 'res':
      case 'err': {
        const pending = this.#pending.get(frame.id)
        if (pending === undefined) return
        this.#pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.t === 'res') pending.resolve(frame.value)
        else pending.reject(new HubRequestError(frame.kind, frame.message, frame.retryAfterMs))
        return
      }
      default:
        if (this.#registration !== undefined) this.#o.onEvent(frame)
    }
  }

  #onClose(link: HubLink, reason: HubLinkClose, opened: boolean): void {
    if (this.#link !== link) return
    this.#link = undefined
    const wasRegistered = this.#registration !== undefined
    this.#registration = undefined
    this.#failPending(new HubUnavailableError('the hub connection closed'))
    if (wasRegistered) {
      this.#o.logger.warn('lost the hub connection; reconnecting', { reason })
      this.#o.onDisconnected()
    }
    if (opened || reason !== 'closed') this.#retry(this.#lastProblem ?? `connection ${reason}`)
  }

  #retry(problem: string): void {
    // Stopped, or a retry is already set (one failed attempt can land here twice).
    if (this.#stopped || this.#retryTimer !== undefined) return
    if (this.#lastProblem !== problem) {
      this.#o.logger.info('the hub is not reachable; retrying', { problem })
    }
    this.#lastProblem = problem
    const wait = this.#retryMs
    this.#retryMs = Math.min(wait * 2, this.#o.maxRetryMs ?? DEFAULT_MAX_RETRY_MS)
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      this.#attempt()
    }, wait)
  }

  #failPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.#pending.delete(id)
    }
  }
}
