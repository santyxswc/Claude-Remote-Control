import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * One hook message on the wire: a single line
 *
 *   tb1 <base64url HMAC-SHA256(secret, json)> <json>\n
 *
 * The secret itself never travels, so a process squatting the endpoint learns
 * nothing it could replay elsewhere. `JSON.stringify` never emits a raw
 * newline, so the newline ends the frame.
 */
export const FRAME_VERSION = 'tb1'

/** Upper bound of one frame, newline included. */
export const MAX_FRAME_BYTES = 256 * 1024

/** Sent back for an accepted frame. */
export const ACK = 'k'

const MAC_BYTES = 32

export function encodeFrame(secret: Uint8Array, json: string): string {
  return `${FRAME_VERSION} ${mac(secret, json).toString('base64url')} ${json}\n`
}

/** The JSON text of a well-formed, authentic frame line (without the newline), else undefined. */
export function verifyFrame(secret: Uint8Array, line: string): string | undefined {
  const first = line.indexOf(' ')
  const second = line.indexOf(' ', first + 1)
  if (first < 0 || second < 0 || line.slice(0, first) !== FRAME_VERSION) return undefined
  const given = Buffer.from(line.slice(first + 1, second), 'base64url')
  const json = line.slice(second + 1)
  if (given.length !== MAC_BYTES) return undefined
  return timingSafeEqual(given, mac(secret, json)) ? json : undefined
}

function mac(secret: Uint8Array, json: string): Buffer {
  return createHmac('sha256', secret).update(json, 'utf8').digest()
}
