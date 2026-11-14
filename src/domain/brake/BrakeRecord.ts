/**
 * The panic brake (F6): who engaged it, when and why. Kept free of imports so
 * the PreToolUse hook entrypoint can load it without anything else.
 */

/** A reason longer than this is cut; it is shown at the terminal and to Claude. */
export const BRAKE_REASON_MAX_LENGTH = 200

/** The format version written to the flag file. */
export const BRAKE_RECORD_VERSION = 1

export interface BrakeRecord {
  /** Epoch milliseconds. */
  readonly engagedAt: number
  /** Audit-style actor: `telegram:<sender id>` or `terminal`. */
  readonly actor: string
  /** Optional free text from the owner, already sanitized. */
  readonly reason: string | undefined
}

export type BrakeSource = 'telegram' | 'terminal' | 'unknown'

/** Where the brake was engaged from, for the message shown at the terminal. */
export function brakeSource(actor: string): BrakeSource {
  if (actor === 'terminal') return 'terminal'
  return actor.startsWith('telegram:') ? 'telegram' : 'unknown'
}

/**
 * One line of plain text: control characters become spaces, whitespace is
 * collapsed, and the result is cut to `BRAKE_REASON_MAX_LENGTH`. Empty means none.
 */
export function sanitizeBrakeReason(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const flat = Array.from(raw, (char) => (isControl(char) ? ' ' : char)).join('')
  const text = flat.replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  const chars = Array.from(text)
  return chars.length <= BRAKE_REASON_MAX_LENGTH
    ? text
    : `${chars.slice(0, BRAKE_REASON_MAX_LENGTH - 1).join('')}…`
}

/** C0 and C1 controls, DEL, and the Unicode line and paragraph separators. */
function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

/** The flag file's JSON form. */
export function serializeBrakeRecord(record: BrakeRecord): string {
  return `${JSON.stringify({
    v: BRAKE_RECORD_VERSION,
    engagedAt: record.engagedAt,
    actor: record.actor,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  })}\n`
}

/** Undefined when the text is not a record this version wrote. */
export function parseBrakeRecord(text: string): BrakeRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const data = value as Record<string, unknown>
  const { v, engagedAt, actor, reason } = data
  if (v !== BRAKE_RECORD_VERSION) return undefined
  if (typeof engagedAt !== 'number' || !Number.isFinite(engagedAt) || engagedAt < 0) {
    return undefined
  }
  if (typeof actor !== 'string' || actor.length === 0 || actor.length > 64) return undefined
  if (reason !== undefined && typeof reason !== 'string') return undefined
  // Sanitized again: the file is outside our control once written.
  return { engagedAt, actor, reason: sanitizeBrakeReason(reason) }
}
