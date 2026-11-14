import { deflateSync, inflateSync } from 'node:zlib'

/**
 * A real, valid PNG of `width` x `height` grey pixels (8-bit RGB), built by
 * hand so tests need no image library: signature, IHDR, IDAT, IEND, each
 * with its CRC-32.
 */
export function makePng(width: number, height: number): Uint8Array {
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x80)
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0 // filter type: none
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // bit depth 8, colour type RGB, deflate, no filter, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

export interface DecodedPng {
  readonly width: number
  readonly height: number
  /** RGBA, 8 bits per channel, row by row. */
  readonly rgba: Uint8Array
}

/**
 * Decodes the PNGs the chart renderer writes (8-bit RGBA or RGB, not
 * interlaced), enough for tests to count pixels without an image library.
 */
export function decodePng(png: Uint8Array): DecodedPng {
  const view = Buffer.from(png)
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const data: Buffer[] = []
  while (offset < view.length) {
    const length = view.readUInt32BE(offset)
    const type = view.toString('ascii', offset + 4, offset + 8)
    const body = view.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]]
      if (depth !== 8 || interlace !== 0 || (colour !== 6 && colour !== 2)) {
        throw new Error('unsupported PNG')
      }
      channels = colour === 6 ? 4 : 3
    }
    if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const current = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (current[x - channels] ?? 0) : 0
      const b = previous[x] ?? 0
      const c = x >= channels ? (previous[x - channels] ?? 0) : 0
      const value = line[x] ?? 0
      let predicted = 0
      if (filter === 1) predicted = a
      else if (filter === 2) predicted = b
      else if (filter === 3) predicted = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      current[x] = (value + predicted) & 0xff
    }
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      out[at] = current[x * channels] ?? 0
      out[at + 1] = current[x * channels + 1] ?? 0
      out[at + 2] = current[x * channels + 2] ?? 0
      out[at + 3] = channels === 4 ? (current[x * channels + 3] ?? 0) : 255
    }
    previous = current
  }
  return { width, height, rgba: out }
}

/** Pixels that are clearly not white (text, axes, marks). */
export function darkPixels(image: DecodedPng): number {
  let count = 0
  for (let i = 0; i < image.rgba.length; i += 4) {
    const r = image.rgba[i] ?? 255
    const g = image.rgba[i + 1] ?? 255
    const b = image.rgba[i + 2] ?? 255
    if (r + g + b < 3 * 160) count += 1
  }
  return count
}
