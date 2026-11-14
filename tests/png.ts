import { deflateSync } from 'node:zlib'

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
