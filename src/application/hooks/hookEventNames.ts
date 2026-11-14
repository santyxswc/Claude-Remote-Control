/**
 * The Claude Code hook events the bridge handles (F4). Kept free of imports
 * so the hook entrypoint can use it without loading zod.
 */
export const HOOK_EVENT_NAMES = ['Stop', 'Notification', 'UserPromptSubmit', 'PostToolUse'] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

export function isHookEventName(value: string | undefined): value is HookEventName {
  return (HOOK_EVENT_NAMES as readonly (string | undefined)[]).includes(value)
}
