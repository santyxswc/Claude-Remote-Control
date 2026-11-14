import type { HookEventName } from '../../application/hooks/hookEventNames.ts'
import { elideMiddle } from '../../domain/elideMiddle.ts'

/**
 * Hook stdin can be huge (`tool_response` of a file read, the content of a
 * `Write`). Only the fields the channel uses are forwarded, clamped, so a
 * frame always fits `MAX_FRAME_BYTES` and nothing more than needed leaves
 * the hook process. The prompt text of `UserPromptSubmit` is never forwarded.
 */
const LIMITS = {
  id: 256,
  cwd: 4096,
  /** The notice keeps 3,500; head and tail survive here, the channel elides again. */
  lastMessage: 16_384,
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
  last_assistant_message?: unknown
  tool_input?: unknown
}

interface ForwardedHookInput extends Json {
  last_assistant_message?: string
  tool_input?: Json
}

export function projectHookPayload(event: HookEventName, raw: unknown): Json {
  const input: RawHookInput = isObject(raw) ? raw : {}
  const out: ForwardedHookInput = { hook_event_name: event }
  copy(input, out, 'session_id', LIMITS.id)
  copy(input, out, 'cwd', LIMITS.cwd)
  switch (event) {
    case 'Stop':
      if (typeof input.last_assistant_message === 'string') {
        out.last_assistant_message = elideMiddle(input.last_assistant_message, LIMITS.lastMessage)
      }
      break
    case 'Notification':
      copy(input, out, 'message', LIMITS.notification)
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

function copy(from: Json, to: Json, key: string, max: number): void {
  const value = from[key]
  if (typeof value === 'string') to[key] = value.slice(0, max)
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
