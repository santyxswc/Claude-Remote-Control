import type { HookEventName } from '../../application/hooks/hookEventNames.ts'

/**
 * Hook stdin can be huge (`tool_response` of a file read, the content of a
 * `Write`). Only the fields the channel uses are forwarded, clamped, so a
 * frame always fits `MAX_FRAME_BYTES` and nothing more than needed leaves
 * the hook process. The prompt text of `UserPromptSubmit` is never forwarded.
 *
 * Texts are cut only at their end, and the cut is flagged (`<field>_truncated`):
 * the hook has no secrets to redact with, so a cut may fall inside one, and the
 * channel drops the partial last line before redacting (M3). A middle elision
 * here would leave a secret's tail at the start of the kept end, which no
 * detector recognizes.
 */
/** Long enough for nearly every final message; worst case 6 bytes per unit, within the frame. */
export const MAX_LAST_MESSAGE_LENGTH = 32_768

const LIMITS = {
  id: 256,
  cwd: 4096,
  lastMessage: MAX_LAST_MESSAGE_LENGTH,
  notification: 4096,
  toolName: 256,
  /** Per `tool_input` string field: enough for the matching fragment. */
  toolField: 1024,
} as const

/** Worst case (every character JSON-escaped to six bytes) stays far below the frame cap. */
const MAX_TOOL_FIELDS = 16

type Json = Record<string, unknown>

/** The fields read by name; everything else is ignored. */
interface RawHookInput extends Json {
  tool_input?: unknown
}

interface ForwardedHookInput extends Json {
  tool_input?: Json
}

export function projectHookPayload(event: HookEventName, raw: unknown): Json {
  const input: RawHookInput = isObject(raw) ? raw : {}
  const out: ForwardedHookInput = { hook_event_name: event }
  copy(input, out, 'session_id', LIMITS.id)
  copy(input, out, 'cwd', LIMITS.cwd)
  switch (event) {
    case 'Stop':
      copy(input, out, 'last_assistant_message', LIMITS.lastMessage, true)
      break
    case 'Notification':
      copy(input, out, 'message', LIMITS.notification, true)
      copy(input, out, 'title', LIMITS.notification)
      copy(input, out, 'notification_type', LIMITS.id)
      break
    case 'PostToolUse':
      copy(input, out, 'tool_name', LIMITS.toolName)
      if (isObject(input.tool_input)) out.tool_input = stringFields(input.tool_input)
      break
    case 'UserPromptSubmit':
      break
  }
  return out
}

/** Copies a string field cut to its head; `flag` records a cut as `<key>_truncated: true`. */
function copy(from: Json, to: Json, key: string, max: number, flag = false): void {
  const value = from[key]
  if (typeof value !== 'string') return
  if (value.length <= max) {
    to[key] = value
    return
  }
  // Never keep half of a surrogate pair.
  const end = isHighSurrogate(value.charCodeAt(max - 1)) ? max - 1 : max
  to[key] = value.slice(0, end)
  if (flag) to[`${key}_truncated`] = true
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** Top-level string fields only, each cut to its head (where the identifying part is). */
function stringFields(input: Json): Json {
  const out: Json = {}
  for (const [key, value] of Object.entries(input).slice(0, MAX_TOOL_FIELDS)) {
    if (typeof value === 'string') out[key] = value.slice(0, LIMITS.toolField)
  }
  return out
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
