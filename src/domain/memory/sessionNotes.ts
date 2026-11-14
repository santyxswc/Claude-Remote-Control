/**
 * Where approved memory lines go in `CLAUDE.md` (F12): `- ` bullets under a
 * fixed `## Session notes` heading, created once at the end of the file.
 * Pure text in, text out; everything already in the file stays byte for byte.
 */

export const SESSION_NOTES_HEADING = '## Session notes'

const FENCE = /^ {0,3}(```|~~~)/
const SECTION_BREAK = /^ {0,3}#{1,2}(?:\s|$)/

/**
 * The file with `lines` appended. If the heading exists (outside code
 * fences), the bullets go right after the last non-blank line of its section,
 * before the next level-one or level-two heading; otherwise the heading is
 * added at the end. Line endings follow the file (CRLF if it uses CRLF).
 */
export function appendSessionNotes(existing: string, lines: readonly string[]): string {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const bullets = lines.map((line) => `- ${line}`).join(eol)
  const parsed = splitLines(existing)
  const heading = findHeading(parsed)
  if (heading === undefined) {
    if (existing === '' || existing === '\uFEFF') {
      return `${existing}${SESSION_NOTES_HEADING}${eol}${eol}${bullets}${eol}`
    }
    const ending = existing.endsWith('\n') ? '' : eol
    return `${existing}${ending}${eol}${SESSION_NOTES_HEADING}${eol}${eol}${bullets}${eol}`
  }
  const end = sectionEnd(parsed, heading)
  let last = heading
  for (let index = heading + 1; index < end; index++) {
    if ((parsed[index]?.text ?? '').trim() !== '') last = index
  }
  const at = parsed[last]?.end ?? existing.length
  const gap = last === heading ? eol : ''
  const tail = existing.slice(at)
  // The file ended right after that line, without a line break: end with one.
  const close = tail === '' ? eol : ''
  return `${existing.slice(0, at)}${eol}${gap}${bullets}${close}${tail}`
}

interface Line {
  readonly text: string
  /** Offset just past the text, before its line break. */
  readonly end: number
}

function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (;;) {
    const newline = text.indexOf('\n', start)
    if (newline === -1) {
      if (start < text.length) lines.push({ text: text.slice(start), end: text.length })
      return lines
    }
    const end = newline > start && text[newline - 1] === '\r' ? newline - 1 : newline
    lines.push({ text: text.slice(start, end), end })
    start = newline + 1
  }
}

/** Index of the heading line outside code fences; a BOM before it is ignored. */
function findHeading(lines: readonly Line[]): number | undefined {
  let fenced = false
  for (const [index, line] of lines.entries()) {
    const text = index === 0 ? line.text.replace(/^\uFEFF/, '') : line.text
    if (FENCE.test(text)) fenced = !fenced
    else if (!fenced && text.trimEnd() === SESSION_NOTES_HEADING) return index
  }
  return undefined
}

function sectionEnd(lines: readonly Line[], heading: number): number {
  let fenced = false
  for (let index = heading + 1; index < lines.length; index++) {
    const text = lines[index]?.text ?? ''
    if (FENCE.test(text)) fenced = !fenced
    else if (!fenced && SECTION_BREAK.test(text)) return index
  }
  return lines.length
}
