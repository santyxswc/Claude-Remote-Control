const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Unpadded base64url (RFC 4648 section 5). Pure, so the domain needs no runtime builtins. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1] ?? 0
    const b2 = bytes[i + 2] ?? 0
    const triple = (b0 << 16) | (b1 << 8) | b2
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6))
    for (let c = 0; c < chars; c++) {
      out += ALPHABET[(triple >> (18 - 6 * c)) & 63]
    }
  }
  return out
}
