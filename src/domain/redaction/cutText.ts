import { ELLIPSIS } from '../elideMiddle.ts'

/**
 * For a text that was cut at its end before it could be redacted (the hook
 * process has no secrets to redact with). The cut may fall inside a secret,
 * leaving a prefix that no detector recognizes, so the partial last line goes
 * too; a text of one long line loses its partial last word instead. Secrets
 * do not span lines, except PEM blocks, which are redacted to the end when
 * their END line is missing. The ellipsis marks the cut.
 */
export function dropCutTail(text: string): string {
  const line = text.lastIndexOf('\n')
  if (line !== -1) return `${text.slice(0, line + 1)}${ELLIPSIS}`
  const word = text.search(/\s\S*$/)
  return word === -1 ? ELLIPSIS : `${text.slice(0, word + 1)}${ELLIPSIS}`
}
