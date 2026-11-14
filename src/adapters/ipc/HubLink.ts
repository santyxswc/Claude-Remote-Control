import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'

/**
 * One hub <-> spoke connection (F14, ADR 0017): a long-lived Unix socket or
 * named pipe carrying newline-terminated frames in both directions.
 *
 *   both sides, first:  tb2-hello <32 hex nonce>\n
 *   then, each frame:   tb2 <base64url MAC> <json>\n
 *
 * MAC = HMAC-SHA256(secret, "tb2|<server nonce>|<client nonce>|<s or c>|<seq>|" + json),
 * the same 32-byte secret as hook frames (`hooks.key`); the different input
 * keeps a hook frame from ever verifying as a hub frame or the reverse. Both
 * nonces are fresh per connection and every frame has a direction and a
 * sequence number, so a recorded frame cannot be replayed, reflected,
 * reordered or moved to another connection. Any frame that fails is fatal:
 * the connection is closed. Frames are capped like hook frames are, and a
 * peer that stops reading is cut off once its backlog passes a bound, so a
 * slow spoke cannot make the hub buffer without limit.
 */
export const HUB_FRAME_VERSION = 'tb2'
const HELLO = 'tb2-hello'

/** One frame at most, newline included: a forwarded hook frame (256 KiB) plus its envelope. */
export const MAX_HUB_FRAME_BYTES = 512 * 1024

/** Bytes queued for a peer that does not read; beyond this the connection is closed. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

/** The peer's hello must arrive by then. */
export const HANDSHAKE_TIMEOUT_MS = 2_000

const NONCE = /^[0-9a-f]{32}$/
const MAC_BYTES = 32

export type HubLinkRole = 'server' | 'client'

export type HubLinkClose =
  | 'closed'
  | 'unauthenticated'
  | 'oversize'
  | 'malformed'
  | 'handshake_timeout'
  | 'backlog'

export interface HubLinkOptions {
  readonly secret: Uint8Array
  readonly role: HubLinkRole
  /** Parsed JSON of each authentic frame, in order. Validation is the caller's. */
  readonly onFrame: (frame: unknown) => void
  readonly onClose: (reason: HubLinkClose) => void
  readonly maxFrameBytes?: number
  readonly maxBufferedBytes?: number
  readonly handshakeTimeoutMs?: number
}

export class HubLink {
  readonly #socket: Socket
  readonly #o: HubLinkOptions
  readonly #ownNonce = randomBytes(16).toString('hex')
  #peerNonce: string | undefined
  #sendSeq = 0
  #recvSeq = 0
  #pending: Buffer[] = []
  #pendingBytes = 0
  #closed = false
  #closeReason: HubLinkClose = 'closed'
  readonly #handshakeTimer: ReturnType<typeof setTimeout>
  readonly ready: Promise<boolean>
  #resolveReady: (ok: boolean) => void = () => {}

  constructor(socket: Socket, options: HubLinkOptions) {
    this.#socket = socket
    this.#o = options
    this.ready = new Promise((resolve) => {
      this.#resolveReady = resolve
    })
    this.#handshakeTimer = setTimeout(
      () => this.close('handshake_timeout'),
      options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    )
    socket.on('data', (chunk: Buffer) => this.#onData(chunk))
    socket.on('error', () => this.close('closed'))
    socket.on('close', () => this.#finish())
    socket.write(`${HELLO} ${this.#ownNonce}\n`)
  }

  get isOpen(): boolean {
    return !this.#closed && this.#peerNonce !== undefined
  }

  /** Queues one frame. False when the link is not open or the peer's backlog is too big. */
  send(frame: unknown): boolean {
    if (!this.isOpen) return false
    if (this.#socket.writableLength > (this.#o.maxBufferedBytes ?? MAX_BUFFERED_BYTES)) {
      this.close('backlog')
      return false
    }
    const json = JSON.stringify(frame)
    const direction = this.#o.role === 'server' ? 's' : 'c'
    const mac = this.#mac(direction, this.#sendSeq++, json)
    const line = `${HUB_FRAME_VERSION} ${mac.toString('base64url')} ${json}\n`
    if (Buffer.byteLength(line) > (this.#o.maxFrameBytes ?? MAX_HUB_FRAME_BYTES)) {
      // Never sent: the peer would drop the link. The caller learns it from `false`.
      this.#sendSeq -= 1
      return false
    }
    this.#socket.write(line)
    return true
  }

  close(reason: HubLinkClose = 'closed'): void {
    if (this.#closed) return
    this.#closed = true
    this.#closeReason = reason
    this.#socket.destroy()
    this.#finish()
  }

  #finished = false
  #finish(): void {
    if (this.#finished) return
    this.#finished = true
    this.#closed = true
    clearTimeout(this.#handshakeTimer)
    this.#resolveReady(false)
    this.#o.onClose(this.#closeReason)
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) return
    const max = this.#o.maxFrameBytes ?? MAX_HUB_FRAME_BYTES
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(0x0a, start)
      if (newline < 0) break
      const part = chunk.subarray(start, newline)
      if (this.#pendingBytes + part.length >= max) {
        this.close('oversize')
        return
      }
      this.#pending.push(part)
      const line = Buffer.concat(this.#pending).toString('utf8')
      this.#pending = []
      this.#pendingBytes = 0
      start = newline + 1
      this.#onLine(line)
      if (this.#closed) return
    }
    const rest = chunk.subarray(start)
    this.#pendingBytes += rest.length
    if (this.#pendingBytes >= max) {
      this.close('oversize')
      return
    }
    if (rest.length > 0) this.#pending.push(rest)
  }

  #onLine(line: string): void {
    if (this.#peerNonce === undefined) {
      const [tag, nonce, extra] = line.split(' ')
      if (tag !== HELLO || nonce === undefined || !NONCE.test(nonce) || extra !== undefined) {
        this.close('malformed')
        return
      }
      this.#peerNonce = nonce
      clearTimeout(this.#handshakeTimer)
      this.#resolveReady(true)
      return
    }
    const first = line.indexOf(' ')
    const second = line.indexOf(' ', first + 1)
    if (first < 0 || second < 0 || line.slice(0, first) !== HUB_FRAME_VERSION) {
      this.close('malformed')
      return
    }
    const given = Buffer.from(line.slice(first + 1, second), 'base64url')
    const json = line.slice(second + 1)
    const direction = this.#o.role === 'server' ? 'c' : 's'
    const expected = this.#mac(direction, this.#recvSeq, json)
    if (given.length !== MAC_BYTES || !timingSafeEqual(given, expected)) {
      this.close('unauthenticated')
      return
    }
    this.#recvSeq += 1
    let frame: unknown
    try {
      frame = JSON.parse(json)
    } catch {
      this.close('malformed')
      return
    }
    this.#o.onFrame(frame)
  }

  #mac(direction: 's' | 'c', seq: number, json: string): Buffer {
    const server = this.#o.role === 'server' ? this.#ownNonce : this.#peerNonce
    const client = this.#o.role === 'client' ? this.#ownNonce : this.#peerNonce
    return createHmac('sha256', this.#o.secret)
      .update(`${HUB_FRAME_VERSION}|${server}|${client}|${direction}|${seq}|`, 'utf8')
      .update(json, 'utf8')
      .digest()
  }
}
