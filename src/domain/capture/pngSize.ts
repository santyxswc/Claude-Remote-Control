/** The PNG signature plus the IHDR chunk's length, type, width and height. */
export const PNG_HEADER_BYTES = 24

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IHDR = [0x49, 0x48, 0x44, 0x52]

export interface ImageSize {
  readonly width: number
  readonly height: number
}

/**
 * Width and height from the first bytes of a PNG file: the signature, then
 * the IHDR chunk, which the format requires to come first (big-endian
 * 32-bit width at offset 16 and height at 20). Undefined for anything else.
 */
export function readPngSize(head: Uint8Array): ImageSize | undefined {
  if (head.length < PNG_HEADER_BYTES) return undefined
  if (!SIGNATURE.every((byte, i) => head[i] === byte)) return undefined
  if (!IHDR.every((byte, i) => head[12 + i] === byte)) return undefined
  const width = uint32(head, 16)
  const height = uint32(head, 20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  )
}
