import { sanitizeDisplayText } from '../displayText.ts'

/** Bot API `createForumTopic`: "Topic name, 1-128 characters". */
export const MAX_TOPIC_NAME_LENGTH = 128

/** The project part of a name; leaves room for a ` (n)` suffix. */
const MAX_BASE_LENGTH = 64

const FALLBACK = 'session'

/**
 * A topic name from the project directory's base name: controls and bidi
 * tricks removed (the name is chosen by whoever named the directory),
 * whitespace collapsed, bounded. Never empty.
 */
export function baseTopicName(projectName: string | undefined): string {
  const clean = sanitizeDisplayText(projectName ?? '', MAX_BASE_LENGTH)
    .replace(/\s+/g, ' ')
    .trim()
  return clean === '' ? FALLBACK : clean
}

/**
 * `base`, or `base (2)`, `base (3)`... whichever is not taken yet (compared
 * without case), so two sessions never share a visible name.
 */
export function uniqueTopicName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`
    if (!used.has(candidate.toLowerCase())) return candidate.slice(0, MAX_TOPIC_NAME_LENGTH)
  }
}
