/**
 * Untrusted display text (a chat user's name, a username) shown in the
 * terminal, in the chat or in channel meta. Pure; no I/O.
 */

/** Longest name we show, in code points (Telegram allows 64 for each of first and last name). */
export const MAX_DISPLAY_TEXT_LENGTH = 64

const ELLIPSIS = '…'

/**
 * Removed outright: they change how the text around them is shown without
 * being visible themselves. Bidi embeddings, overrides and isolates
 * (U+202A-202E, U+2066-2069), directional marks (U+200E, U+200F, U+061C),
 * zero-width characters (U+200B-200D, U+2060, U+FEFF), invisible operators
 * (U+2061-2064), deprecated format characters (U+206A-206F) and the soft hyphen.
 */
const INVISIBLE =
  /[\u{ad}\u{61c}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{206f}\u{feff}]/gu

/**
 * Replaced by a space: C0 controls (ESC included), DEL, C1 controls, and the
 * line and paragraph separators. A newline in a name must not start a line
 * of its own in the terminal, and ESC must not start an escape sequence.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/gu

/**
 * Makes untrusted text safe to show on one line: no controls or escape
 * sequences, no bidi tricks, no invisible characters, whitespace collapsed,
 * at most `maxLength` code points (an ellipsis marks a cut).
 */
export function sanitizeDisplayText(text: string, maxLength = MAX_DISPLAY_TEXT_LENGTH): string {
  const clean = text.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim()
  const points = [...clean]
  if (points.length <= maxLength) return clean
  return points.slice(0, Math.max(0, maxLength - 1)).join('') + ELLIPSIS
}

/**
 * The same cleaning for longer untrusted text that may span lines (a question
 * Claude asks): controls, bidi tricks and invisible characters go, runs of
 * blanks collapse, but line breaks stay. No length cap: callers that show it
 * must never hide part of it silently.
 */
export function sanitizeMultilineText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .split('\n')
    .map((line) =>
      line
        .replace(CONTROL, ' ')
        .replace(/[^\S\n]+/gu, ' ')
        .trimEnd(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Telegram usernames: 5-32 of `A-Z a-z 0-9 _` (a few old ones are shorter). */
const USERNAME = /^[A-Za-z0-9_]{1,32}$/

/** The username if it is shaped like one; anything else is dropped rather than shown. */
export function sanitizeUsername(username: string | undefined): string | undefined {
  return username !== undefined && USERNAME.test(username) ? username : undefined
}

/** How to name a sender in one short phrase: `@username`, else the sanitized display name. */
export function senderLabel(sender: {
  readonly username: string | undefined
  readonly displayName: string
}): string {
  const username = sanitizeUsername(sender.username)
  return username === undefined ? sanitizeDisplayText(sender.displayName) : `@${username}`
}
