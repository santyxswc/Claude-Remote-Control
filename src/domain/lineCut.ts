/**
 * Cutting long text only between lines, for documents built from untrusted
 * content (a diff, F8). A line is never split: half a secret is not
 * recognizable by any detector, while a whole line either is or is not. Pure.
 */

/** UTF-8 length of `text`, counting a lone surrogate as the 3-byte replacement character. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && isLow(text.charCodeAt(i + 1))) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/**
 * The longest prefix of whole lines (each ending with `\n`) that fits in
 * `maxBytes` of UTF-8; the whole text when it fits. A text whose first line
 * alone is too long keeps nothing.
 */
export function cutAtLineBoundary(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly cut: boolean } {
  let bytes = 0
  let lastLineEnd = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    let size: number
    if (code < 0x80) size = 1
    else if (code < 0x800) size = 2
    else if (code >= 0xd800 && code <= 0xdbff && isLow(text.charCodeAt(i + 1))) size = 4
    else size = 3
    if (bytes + size > maxBytes) return { text: text.slice(0, lastLineEnd), cut: true }
    bytes += size
    if (size === 4) i += 1
    if (code === 0x0a) lastLineEnd = i + 1
  }
  return { text, cut: false }
}

/**
 * For output that was cut while it was read (a size cap): drops the partial
 * last line, which may hold the first half of a secret.
 */
export function keepCompleteLines(text: string): string {
  return text.slice(0, text.lastIndexOf('\n') + 1)
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
