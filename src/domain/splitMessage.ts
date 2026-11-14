import { DomainError } from './DomainError.ts'

export class InvalidChunkLengthError extends DomainError {
  constructor() {
    super('A message chunk must allow at least 2 code units')
  }
}

/**
 * Separators tried in order. A cut on a separator drops the separator
 * itself; a cut is only taken in the second half of the window so a
 * boundary near the start cannot produce a tiny chunk.
 */
const SEPARATORS = ['\n\n', '\n', ' '] as const

/**
 * Splits `text` into chunks of at most `maxLength` UTF-16 code units (the
 * unit of JavaScript string length), preferring a paragraph boundary, then a
 * line break, then a space, then a hard cut. A hard cut never separates the
 * two halves of a surrogate pair. Whitespace-only chunks are dropped, so an
 * all-whitespace text yields no chunks.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 2) throw new InvalidChunkLengthError()
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxLength) {
    const { end, resume } = findCut(rest, maxLength)
    chunks.push(rest.slice(0, end))
    rest = rest.slice(resume)
  }
  chunks.push(rest)
  return chunks.filter((chunk) => chunk.trim() !== '')
}

function findCut(text: string, maxLength: number): { end: number; resume: number } {
  const minimum = Math.floor(maxLength / 2)
  for (const separator of SEPARATORS) {
    // A separator starting at maxLength still leaves a chunk of exactly maxLength.
    const at = text.lastIndexOf(separator, maxLength)
    if (at >= minimum && at > 0) return { end: at, resume: at + separator.length }
  }
  const end = splitsSurrogatePair(text, maxLength) ? maxLength - 1 : maxLength
  return { end, resume: end }
}

function splitsSurrogatePair(text: string, at: number): boolean {
  const before = text.charCodeAt(at - 1)
  const after = text.charCodeAt(at)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}
