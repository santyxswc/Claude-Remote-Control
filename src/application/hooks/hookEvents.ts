import { z } from 'zod'

/**
 * Hook payloads as forwarded by the hook entrypoint (hooks reference, fetched
 * 2026-11-14). Lenient on purpose: unknown fields are allowed and every
 * optional field may be missing, so a newer Claude Code does not break us.
 * Every value is untrusted.
 */
const MAX_TEXT = 65_536

const optionalText = z.string().max(MAX_TEXT).optional()

const common = {
  session_id: z.string().max(256).optional(),
  cwd: z.string().max(4096).optional(),
}

const StopPayload = z.looseObject({
  ...common,
  hook_event_name: z.literal('Stop'),
  last_assistant_message: optionalText,
})

const NotificationPayload = z.looseObject({
  ...common,
  hook_event_name: z.literal('Notification'),
  message: optionalText,
  notification_type: z.string().max(256).optional(),
})

const UserPromptSubmitPayload = z.looseObject({
  ...common,
  hook_event_name: z.literal('UserPromptSubmit'),
})

const PostToolUsePayload = z.looseObject({
  ...common,
  hook_event_name: z.literal('PostToolUse'),
  tool_name: z.string().min(1).max(256),
  tool_input: z.record(z.string(), z.unknown()).optional(),
})

const HookPayload = z.discriminatedUnion('hook_event_name', [
  StopPayload,
  NotificationPayload,
  UserPromptSubmitPayload,
  PostToolUsePayload,
])

interface HookEventBase {
  readonly sessionId: string | undefined
  readonly cwd: string | undefined
}

export type HookEvent =
  | (HookEventBase & { readonly name: 'Stop'; readonly lastAssistantMessage: string | undefined })
  | (HookEventBase & {
      readonly name: 'Notification'
      readonly message: string | undefined
      readonly notificationType: string | undefined
    })
  | (HookEventBase & { readonly name: 'UserPromptSubmit' })
  | (HookEventBase & {
      readonly name: 'PostToolUse'
      readonly toolName: string
      readonly toolInput: Readonly<Record<string, unknown>> | undefined
    })

export type HookParseResult =
  | { readonly ok: true; readonly event: HookEvent }
  /** Field paths only: values are untrusted and may hold secrets. */
  | { readonly ok: false; readonly fields: readonly string[] }

export function parseHookEvent(raw: unknown): HookParseResult {
  const parsed = HookPayload.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, fields: parsed.error.issues.map((issue) => issue.path.join('.')) }
  }
  const data = parsed.data
  const base = { sessionId: data.session_id, cwd: data.cwd }
  switch (data.hook_event_name) {
    case 'Stop':
      return {
        ok: true,
        event: { ...base, name: 'Stop', lastAssistantMessage: data.last_assistant_message },
      }
    case 'Notification':
      return {
        ok: true,
        event: {
          ...base,
          name: 'Notification',
          message: data.message,
          notificationType: data.notification_type,
        },
      }
    case 'UserPromptSubmit':
      return { ok: true, event: { ...base, name: 'UserPromptSubmit' } }
    case 'PostToolUse':
      return {
        ok: true,
        event: {
          ...base,
          name: 'PostToolUse',
          toolName: data.tool_name,
          toolInput: data.tool_input,
        },
      }
  }
}
