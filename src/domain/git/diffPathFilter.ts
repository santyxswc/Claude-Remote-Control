/**
 * The optional path argument of `/diff` (F8). It ends up as a pathspec after
 * `--` with literal pathspecs forced, so git never reads it as an option or
 * as pathspec magic; this policy refuses those shapes anyway, plus anything
 * that could name a place outside the working directory. Pure.
 */

/** Longer arguments are refused rather than cut. */
export const MAX_DIFF_PATH_LENGTH = 1024

export type DiffPathProblem =
  | 'empty'
  | 'too_long'
  | 'control'
  | 'absolute'
  | 'traversal'
  | 'option'
  | 'magic'

export type DiffPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly problem: DiffPathProblem }

/**
 * C0 and C1 controls (NUL, newline and ESC included), DEL, line and paragraph
 * separators, and bidi embeddings, overrides and isolates (a path shown back
 * in the chat must not be able to reorder itself).
 */
const UNSAFE_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u

/** `/x`, `\x`, `C:x`, `C:\x` and `\\server\share`: anything rooted outside the working directory. */
const ROOTED = /^(?:[\\/]|[A-Za-z]:)/

/**
 * A relative path inside the working directory, normalized to forward
 * slashes without `.` or empty segments (`.` itself for the whole tree).
 * Refused: empty, over the length cap, controls, absolute or drive paths, any
 * `..` segment, a leading `-` (an option) and a leading `:` (pathspec magic
 * such as `:(glob)`, `:!x` or `:/`).
 */
export function parseDiffPathFilter(raw: string): DiffPathResult {
  if (raw === '') return { ok: false, problem: 'empty' }
  if (raw.length > MAX_DIFF_PATH_LENGTH) return { ok: false, problem: 'too_long' }
  if (UNSAFE_CHARACTERS.test(raw)) return { ok: false, problem: 'control' }
  if (raw.startsWith('-')) return { ok: false, problem: 'option' }
  if (raw.startsWith(':')) return { ok: false, problem: 'magic' }
  if (ROOTED.test(raw)) return { ok: false, problem: 'absolute' }
  const segments = raw.split(/[\\/]/)
  if (segments.some((segment) => segment === '..')) return { ok: false, problem: 'traversal' }
  const kept = segments.filter((segment) => segment !== '' && segment !== '.')
  // `./-x` normalizes to `-x`: still never an option, it goes after `--`, but refuse it the same.
  if (kept[0]?.startsWith('-') === true) return { ok: false, problem: 'option' }
  if (kept[0]?.startsWith(':') === true) return { ok: false, problem: 'magic' }
  return { ok: true, path: kept.length === 0 ? '.' : kept.join('/') }
}
