/**
 * Session summaries saved to `docs/sessions/` (F12): the file name and the
 * text, as pure functions. The bridge writes the file, not Claude, so these
 * decide exactly what lands on disk.
 */
import { sanitizeDisplayText } from '../displayText.ts'
import { utf8Length } from '../utf8Length.ts'

/** Largest summary written, in UTF-8 bytes (heading included). */
export const MAX_SUMMARY_BYTES = 200_000
/** Longest title, in code points, after sanitizing. */
export const MAX_SUMMARY_TITLE_LENGTH = 120
/** Longest slug in a file name. */
export const MAX_SUMMARY_SLUG_LENGTH = 60
/** Where summaries go, relative to the project, as path segments. */
export const SESSION_SUMMARY_DIR = ['docs', 'sessions'] as const

export type SummaryProblem = 'empty_title' | 'title_too_long' | 'empty_summary' | 'too_large'

export type SummaryCheck =
  | { readonly ok: true; readonly title: string; readonly document: string }
  | { readonly ok: false; readonly problem: SummaryProblem }

/**
 * Bidi embeddings, overrides and isolates, directional marks, zero-width and
 * invisible format characters: they would make the file read differently
 * from what it holds (the "Trojan Source" trick).
 */
const INVISIBLE =
  /[\u{61c}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{206f}\u{feff}]/gu
/** C0 controls except tab and newline, DEL and C1 controls. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu

/** Plain UTF-8 text with `\n` line ends, no controls but tab and newline, no invisible tricks. */
export function cleanSummaryText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(CONTROL, '')
}

/**
 * The file's content: the summary as Claude wrote it (cleaned), under a
 * `# <title>` heading unless it already starts with a level-one heading.
 * Refused, never cut, when it is empty or over the size cap.
 */
export function prepareSessionSummary(rawTitle: string, rawMarkdown: string): SummaryCheck {
  const title = sanitizeDisplayText(rawTitle, Number.POSITIVE_INFINITY)
  if (title === '') return { ok: false, problem: 'empty_title' }
  if ([...title].length > MAX_SUMMARY_TITLE_LENGTH) return { ok: false, problem: 'title_too_long' }
  const body = cleanSummaryText(rawMarkdown).trim()
  if (body === '') return { ok: false, problem: 'empty_summary' }
  const document = `${/^# \S/.test(body) ? body : `# ${title}\n\n${body}`}\n`
  if (utf8Length(document) > MAX_SUMMARY_BYTES) return { ok: false, problem: 'too_large' }
  return { ok: true, title, document }
}

/**
 * ASCII lowercase letters, digits and single hyphens, from the title: accents
 * dropped (`Revisión` -> `revision`), everything else a hyphen, at most 60
 * characters cut at a hyphen. `session` when nothing is left.
 */
export function summarySlug(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii.length <= MAX_SUMMARY_SLUG_LENGTH) return ascii === '' ? 'session' : ascii
  const cut = ascii.slice(0, MAX_SUMMARY_SLUG_LENGTH)
  const hyphen = cut.lastIndexOf('-')
  const slug = (hyphen > 0 ? cut.slice(0, hyphen) : cut).replace(/-+$/g, '')
  return slug === '' ? 'session' : slug
}

/**
 * `2026-11-14T103005Z-<slug>` (UTC, no colons: Windows forbids them). The
 * date prefix also means no name can be a Windows reserved device name.
 * `attempt` 0 is the plain name; later attempts add `-2`, `-3`...
 */
export function summaryFileName(now: number, slug: string, attempt = 0): string {
  const iso = new Date(now).toISOString()
  const stamp = `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  return `${stamp}-${slug}${attempt === 0 ? '' : `-${attempt + 1}`}.md`
}
