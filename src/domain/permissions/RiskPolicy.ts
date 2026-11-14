import type { RiskLevel } from './PermissionRequest.ts'

export interface RiskAssessment {
  readonly level: RiskLevel
  /** Ids of the rules that matched; empty for low risk. Safe to log: no input text. */
  readonly reasons: readonly string[]
}

/** GoF Strategy: decides how dangerous a tool call looks. */
export interface RiskPolicy {
  classify(request: { readonly toolName: string; readonly inputPreview: string }): RiskAssessment
}

export interface RiskRule {
  readonly id: string
  readonly matches: (text: string) => boolean
}

/** Text inside one shell command: stops at `;`, `&`, `|` and newlines. */
const ARGS = String.raw`[^;&|\n]*`

/** Compiled once; no `g` flag, so `test` keeps no state between calls. */
function pattern(source: string, flags = 'i'): (text: string) => boolean {
  const regex = new RegExp(source, flags)
  return (text) => regex.test(text)
}

/**
 * Patterns for destructive or hard-to-undo commands. They run on Claude
 * Code's `input_preview` (JSON-shaped text, so Windows paths show doubled
 * backslashes) and err towards `high`: a false positive costs one extra tap.
 */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  {
    id: 'recursive_delete',
    matches: pattern(String.raw`\brm\s+(?:-{1,2}[\w-]+\s+)*(?:-[a-z]*r[a-z]*|--recursive)\b`),
  },
  { id: 'find_delete', matches: pattern(String.raw`\bfind\b${ARGS}\s-delete\b`) },
  {
    id: 'git_force_push',
    matches: pattern(
      String.raw`\bgit\b${ARGS}\bpush\b${ARGS}(?:\s--force(?:-with-lease)?\b|\s-[a-z]*f[a-z]*\b|\s\+[\w/.-]+)`,
    ),
  },
  { id: 'git_reset_hard', matches: pattern(String.raw`\bgit\b${ARGS}\breset\b${ARGS}\s--hard\b`) },
  { id: 'git_clean_force', matches: pattern(String.raw`\bgit\b${ARGS}\bclean\b${ARGS}\s-[a-z]*f`) },
  {
    id: 'sql_drop',
    matches: pattern(
      String.raw`\bdrop\s+(?:table|database|schema|index|view|user|role|collection)\b`,
    ),
  },
  {
    id: 'sql_truncate',
    matches: pattern(String.raw`\btruncate\s+(?:table\s+[\w.\x60\[\]"]+|[\w.\x60\[\]]+\s*;)`),
  },
  {
    id: 'sql_delete_without_where',
    matches: pattern(String.raw`\bdelete\s+from\s+[\w.\x60\[\]]+\s*(?:;|$|\\?["'])`),
  },
  { id: 'mkfs', matches: pattern(String.raw`\bmkfs(?:\.\w+)?\b`) },
  { id: 'dd_write', matches: pattern(String.raw`\bdd\b${ARGS}\bof=`) },
  {
    id: 'chmod_777_recursive',
    matches: (text) =>
      pattern(String.raw`\bchmod\b${ARGS}\s-[a-z]*R`, '')(text) &&
      pattern(String.raw`\bchmod\b${ARGS}\b0?777\b`)(text),
  },
  {
    id: 'pipe_to_shell',
    matches: pattern(
      String.raw`\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^;&\n]*\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k|fi)?sh|iex|invoke-expression|python3?|node|bun|perl|ruby|pwsh|powershell)\b`,
    ),
  },
  { id: 'privilege_escalation', matches: pattern(String.raw`\b(?:sudo|doas|runas)\b`) },
  {
    id: 'shutdown',
    matches: pattern(
      String.raw`\b(?:shutdown|reboot|poweroff|halt|stop-computer|restart-computer)\b`,
    ),
  },
  {
    id: 'powershell_recursive_delete',
    matches: pattern(String.raw`\bremove-item\b[^;|\n]*\s-recurse\b`),
  },
  {
    id: 'windows_recursive_delete',
    matches: pattern(String.raw`\b(?:rd|rmdir|del|erase)\b${ARGS}\s/s\b`),
  },
  { id: 'windows_format', matches: pattern(String.raw`\bformat(?:\.com)?\s+[a-z]:`) },
  {
    id: 'credential_files',
    matches: pattern(
      String.raw`(?:^|[\\/"'\s~=])(?:\.(?:ssh|aws|gnupg|kube|docker|azure)[\\/]|\.env\b|\.netrc\b|\.npmrc\b|\.pypirc\b|\.git-credentials\b|\.pgpass\b)`,
    ),
  },
  // Claude Code elides the middle of long values; what we cannot see may be anything.
  { id: 'elided_input', matches: pattern(String.raw`⋯\s*\d+\s+code points elided\s*⋯`) },
  { id: 'unserializable_input', matches: pattern(String.raw`\(value unserializable\)`) },
]

/** High when any rule matches the input preview; low otherwise. */
export class PatternRiskPolicy implements RiskPolicy {
  constructor(private readonly rules: readonly RiskRule[] = DEFAULT_RISK_RULES) {}

  classify(request: { readonly toolName: string; readonly inputPreview: string }): RiskAssessment {
    const reasons = this.rules.filter((rule) => rule.matches(request.inputPreview)).map((r) => r.id)
    return { level: reasons.length > 0 ? 'high' : 'low', reasons }
  }
}
