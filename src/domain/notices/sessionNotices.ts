/**
 * `Notification` types that mean Claude waits for the owner (hooks reference,
 * matcher table). Others (`auth_success`, `elicitation_complete`,
 * `agent_completed`, quota and plugin notices...) and unknown types send nothing.
 */
const ATTENTION_TYPES: ReadonlySet<string> = new Set([
  'idle_prompt',
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
])

export type AttentionTrigger = 'idle' | 'permission' | 'other'

/** How a `Notification` hook should be treated; `undefined` means no notice. */
export function attentionTrigger(
  notificationType: string | undefined,
): AttentionTrigger | undefined {
  // Older payloads may lack the field; a message without a type still asks for attention.
  if (notificationType === undefined) return 'other'
  if (!ATTENTION_TYPES.has(notificationType)) return undefined
  if (notificationType === 'idle_prompt') return 'idle'
  if (notificationType === 'permission_prompt') return 'permission'
  return 'other'
}

const MAX_PROJECT_NAME_LENGTH = 80

/** The last path segment of a working directory, on Windows and POSIX alike. */
export function projectName(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment !== '')
  const last = segments.at(-1)
  if (last === undefined || /^[A-Za-z]:$/.test(last)) return undefined
  return last.slice(0, MAX_PROJECT_NAME_LENGTH)
}
