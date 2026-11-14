/** What stands for the removed middle of an elided text. */
export const ELLIPSIS = '…'

/**
 * Shortens `text` to at most `maxLength` UTF-16 code units by keeping its
 * start and its end around an ellipsis, so the end of a long command (often
 * the dangerous part) is still visible. Never separates a surrogate pair.
 */
export function elideMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  if (maxLength <= ELLIPSIS.length) return ELLIPSIS.slice(0, Math.max(0, maxLength))
  const room = maxLength - ELLIPSIS.length
  let headEnd = Math.ceil(room / 2)
  let tailStart = text.length - (room - headEnd)
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1
  return text.slice(0, headEnd) + ELLIPSIS + text.slice(tailStart)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
