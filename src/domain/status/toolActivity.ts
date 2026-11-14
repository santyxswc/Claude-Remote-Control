import { sanitizeDisplayText } from '../displayText.ts'

/** What the pinned status shows about the last tool that ran (F9): never a command or file content. */
export interface ToolActivity {
  readonly tool: string
  /** A Bash/PowerShell `description`, or a file's base name; absent for other tools. */
  readonly detail?: string
}

export const MAX_TOOL_NAME_SHOWN = 64
export const MAX_TOOL_DETAIL_SHOWN = 60

/** Tools whose `description` is Claude's one-line summary of the command (never the command). */
const DESCRIBED_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])

/** Tools that name one file in `file_path` or `notebook_path`. */
const FILE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
])

/**
 * A short, safe summary of a tool call from a `PostToolUse` hook: the tool
 * name, plus the command's `description` (up to 60 characters) for shell
 * tools or a file's base name for file tools. Raw command text, patterns,
 * URLs and file contents are never used. Sanitized here; the outbound
 * pipeline still redacts it.
 */
export function summarizeToolUse(
  toolName: string,
  input: Readonly<Record<string, unknown>> | undefined,
): ToolActivity {
  const tool = sanitizeDisplayText(toolName, MAX_TOOL_NAME_SHOWN)
  const fields: {
    readonly description?: unknown
    readonly file_path?: unknown
    readonly notebook_path?: unknown
  } = input ?? {}
  const detail = DESCRIBED_TOOLS.has(toolName)
    ? text(fields.description)
    : FILE_TOOLS.has(toolName)
      ? baseName(text(fields.file_path) ?? text(fields.notebook_path))
      : undefined
  const shown = detail === undefined ? '' : sanitizeDisplayText(detail, MAX_TOOL_DETAIL_SHOWN)
  return shown === '' ? { tool } : { tool, detail: shown }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function baseName(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  return path
    .split(/[\\/]+/)
    .filter((segment) => segment !== '')
    .at(-1)
}
