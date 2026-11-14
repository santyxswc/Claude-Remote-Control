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

/** Compiled once; no `g` flag, so `test` keeps no state between calls. */
function pattern(source: string, flags = 'i'): (text: string) => boolean {
  const regex = new RegExp(source, flags)
  return (text) => regex.test(text)
}

// ---------------------------------------------------------------------------
// Commands as tokens. Every command rule is a linear scan over these tokens,
// never a regex with two unbounded gaps (those backtracked for seconds on
// repeated "git push " input, L2).

interface Command {
  /** The command's text as it appears in the preview. */
  readonly raw: string
  readonly tokens: readonly string[]
  /** Lowercased tokens. */
  readonly lower: readonly string[]
  /** Program-like name of each token: basename, lowercased, without `.exe`. */
  readonly names: readonly string[]
}

/** Commands of one pipeline, in order. */
type Pipeline = readonly Command[]

interface Parsed {
  readonly pipelines: readonly Pipeline[]
  readonly commands: readonly Command[]
}

// A JSON-escaped newline is `\n` not preceded by another backslash (`C:\\new` is a path).
const SEGMENT_BREAK = /(?<!\\)\\n|[;&\r\n]/
const TOKEN_BREAK = /[\s"'(){}[\],`]+/

function programName(token: string): string {
  const base = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1)
  const lower = base.toLowerCase()
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower
}

function toCommand(raw: string): Command {
  const tokens = raw
    .replaceAll('\\"', ' ')
    .split(TOKEN_BREAK)
    .filter((token) => token !== '')
  return {
    raw,
    tokens,
    lower: tokens.map((token) => token.toLowerCase()),
    names: tokens.map(programName),
  }
}

let cache: { readonly text: string; readonly parsed: Parsed } | undefined

/** Splits a preview into pipelines of commands; memoised for the last text (rules share it). */
function parse(text: string): Parsed {
  if (cache?.text === text) return cache.parsed
  const pipelines = text.split(SEGMENT_BREAK).map((segment) => segment.split('|').map(toCommand))
  const parsed = { pipelines, commands: pipelines.flat() }
  cache = { text, parsed }
  return parsed
}

type TokenTest = (lower: string, index: number, command: Command) => boolean

const is =
  (...words: string[]): TokenTest =>
  (lower) =>
    words.includes(lower)
const named =
  (...programs: string[]): TokenTest =>
  (_lower, index, command) =>
    programs.includes(command.names[index] ?? '')

/** True when tokens matching each test appear in this order (greedy, so linear). */
function follows(command: Command, ...tests: readonly TokenTest[]): boolean {
  let next = 0
  for (let index = 0; index < command.lower.length && next < tests.length; index++) {
    if (tests[next]?.(command.lower[index] ?? '', index, command) === true) next++
  }
  return next === tests.length
}

function anyCommand(predicate: (command: Command) => boolean): (text: string) => boolean {
  return (text) => parse(text).commands.some(predicate)
}

function anyPipeline(predicate: (pipeline: Pipeline) => boolean): (text: string) => boolean {
  return (text) => parse(text).pipelines.some(predicate)
}

/** Index of the first token running one of `programs`, or -1. */
function programIndex(command: Command, programs: readonly string[]): number {
  return command.names.findIndex((name) => programs.includes(name))
}

/** Flags right after the program, up to its first operand. */
function leadingFlags(command: Command, index: number): string[] {
  const flags: string[] = []
  for (const token of command.tokens.slice(index + 1)) {
    if (!token.startsWith('-')) break
    flags.push(token)
  }
  return flags
}

/** The program reads its code from stdin: no operand, `-`, or `-s`. */
function readsStdin(command: Command, index: number): boolean {
  const rest = command.lower.slice(index + 1)
  if (rest.includes('-s') || rest.includes('-')) return true
  const end = rest.indexOf('--')
  return !(end === -1 ? rest : rest.slice(0, end)).some((token) => !token.startsWith('-'))
}

const PREFIXES_OF = (word: string, minimum: number) => (lower: string) =>
  lower.length >= minimum && word.startsWith(lower)

const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']
const INTERPRETERS = [
  ...SHELLS,
  'pwsh',
  'powershell',
  'iex',
  'invoke-expression',
  'python',
  'python3',
  'node',
  'bun',
  'perl',
  'ruby',
]
const DOWNLOADERS = ['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']
const NETWORK = [...DOWNLOADERS, 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp']
const DELETERS = ['rm', 'shred', 'unlink', 'rmdir']
const PS_DELETERS = ['remove-item', 'ri', 'del', 'erase', 'rm', 'rmdir', 'rd']
const PS_LISTERS = ['get-childitem', 'gci', 'ls', 'dir']
const isRecurseFlag = PREFIXES_OF('-recurse', 2)

/** Inline code: its effect cannot be judged from a pattern, so it is always high. */
function runsInlineCode(command: Command): boolean {
  return command.names.some((name, index) => {
    const flags = leadingFlags(command, index)
    switch (name) {
      case 'python':
      case 'python2':
      case 'python3':
      case 'py':
        return flags.some((flag) => /^-[A-Za-z]*c$/.test(flag))
      case 'node':
      case 'nodejs':
      case 'bun':
      case 'deno':
        return flags.some((flag) => /^(?:-e|--eval|-p|--print)(?:=|$)/.test(flag))
      case 'perl':
      case 'ruby':
        return flags.some((flag) => /^-[A-Za-z]*[eE]/.test(flag))
      case 'php':
        return flags.some((flag) => flag === '-r')
      case 'pwsh':
      case 'powershell':
        return flags.some((flag) => {
          const lower = flag.toLowerCase()
          return PREFIXES_OF('-command', 2)(lower) || PREFIXES_OF('-encodedcommand', 2)(lower)
        })
      default:
        return SHELLS.includes(name) && flags.some((flag) => /^-[A-Za-z]*c[A-Za-z]*$/.test(flag))
    }
  })
}

/** A file is downloaded, then run by a later command. */
function downloadsThenRuns(text: string): boolean {
  const downloaded = new Set<string>()
  for (const command of parse(text).commands) {
    const at = programIndex(command, DOWNLOADERS)
    if (at !== -1) {
      for (const name of command.names.slice(at + 1))
        if (!name.startsWith('-')) downloaded.add(name)
      continue
    }
    if (downloaded.size === 0) continue
    const runner = command.names.findIndex(
      (name, index) =>
        INTERPRETERS.includes(name) ||
        name === 'source' ||
        name === '.' ||
        (command.tokens[index] ?? '').startsWith('./'),
    )
    if (runner !== -1 && command.names.slice(runner).some((name) => downloaded.has(name))) {
      return true
    }
  }
  return false
}

/** `UPDATE t SET …` with no WHERE before the statement ends. */
const UPDATE_SET = /\bupdate\s+[\w.`"[\]]{1,128}\s+set\s/gi
function updatesWithoutWhere(text: string): boolean {
  return parse(text).pipelines.some((pipeline) =>
    pipeline.some(({ raw }) => {
      for (const match of raw.matchAll(UPDATE_SET)) {
        const start = match.index + match[0].length
        const quote = raw.indexOf('\\"', start)
        const statement = raw.slice(
          start,
          quote === -1 ? start + 4096 : Math.min(quote, start + 4096),
        )
        if (!/\bwhere\b/i.test(statement)) return true
      }
      return false
    }),
  )
}

/** A separator inside a path as the preview shows it: `/`, `\` or JSON's `\\`. */
const SEP = String.raw`(?:/|\\{1,2})`
/** What may come right before a dotfile or a path: start, a separator, a quote, space, `~`, `=`. */
const PATH_START = String.raw`(?:^|[\\/"'\s~=])`

/**
 * Patterns for destructive or hard-to-undo tool calls. A heuristic second tap,
 * not a sandbox: they run on Claude Code's `input_preview` (JSON-shaped text,
 * so Windows paths show doubled backslashes), err towards `high` (a false
 * positive costs one extra tap), and anything not listed is `low`.
 */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  // The bridge's own state: the brake, the bot token, the hook key, the allowlist.
  {
    id: 'bridge_state',
    matches: pattern(
      String.raw`channels${SEP}telegram-bridge\b|telegram_bridge_home|${PATH_START}(?:brake\.json|hooks\.key|bridge\.sqlite(?:-wal|-shm|-journal)?)\b`,
    ),
  },
  {
    id: 'bridge_cli',
    matches: anyCommand((command) =>
      follows(
        command,
        (lower, index) =>
          command.names[index] === 'telegram-bridge' ||
          command.names[index] === 'cli.ts' ||
          (lower === 'bridge' && command.lower[index - 1] === 'run'),
        is('resume', 'access', 'pair', 'init'),
      ),
    ),
  },
  // Claude Code's own configuration: hooks, permissions, MCP servers, plugins.
  {
    id: 'claude_config',
    matches: pattern(
      String.raw`${PATH_START}\.claude${SEP}(?:settings(?:\.local)?\.json|managed-settings\.json|hooks\b|plugins\b|commands\b|agents\b|skills\b)|${PATH_START}\.(?:claude|mcp)\.json\b|managed-settings\.json`,
    ),
  },
  // Deleting files.
  {
    id: 'recursive_delete',
    matches: anyCommand((command) => {
      const at = programIndex(command, ['rm'])
      if (at === -1) return false
      for (const lower of command.lower.slice(at + 1)) {
        if (lower === '--') return false
        if (lower === '--recursive' || lower.startsWith('--recursive=')) return true
        if (/^-[a-z]*r/.test(lower) && !lower.startsWith('--')) return true
      }
      return false
    }),
  },
  {
    id: 'rm_wildcard',
    matches: anyCommand((command) => {
      const at = programIndex(command, ['rm'])
      return at !== -1 && command.tokens.slice(at + 1).some((token) => token.includes('*'))
    }),
  },
  { id: 'find_delete', matches: anyCommand((c) => follows(c, named('find'), is('-delete'))) },
  {
    id: 'find_exec_delete',
    matches: (text) =>
      parse(text).commands.some((c) =>
        follows(c, named('find'), is('-exec', '-execdir', '-ok', '-okdir'), named(...DELETERS)),
      ) ||
      anyPipeline(
        (pipeline) =>
          pipeline.some((c) => programIndex(c, ['find', 'fd', 'ls', 'git']) !== -1) &&
          pipeline.some((c) => follows(c, named('xargs'), named(...DELETERS))),
      )(text),
  },
  { id: 'shred', matches: anyCommand((c) => programIndex(c, ['shred', 'wipe', 'srm']) !== -1) },
  {
    id: 'truncate_file',
    matches: anyCommand(
      (c) =>
        follows(c, named('truncate'), is('-s', '--size'), is('0')) ||
        follows(c, named('truncate'), is('-s0', '--size=0')),
    ),
  },
  {
    id: 'dotfile_redirect',
    matches: pattern(
      String.raw`>{1,2}\s{0,8}(?:~|\$home|\$\{home\}|%userprofile%|\$env:userprofile|/root|/home/[\w.-]{1,64}|/users/[\w.-]{1,64}|[a-z]:${SEP}users${SEP}[\w.-]{1,64})${SEP}\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zshenv|zprofile|zlogin|gitconfig|ssh${SEP}(?:authorized_keys|config))\b`,
    ),
  },
  { id: 'crontab_remove', matches: anyCommand((c) => follows(c, named('crontab'), is('-r'))) },
  {
    id: 'move_to_null',
    matches: anyCommand((c) => follows(c, named('mv'), (lower) => lower === '/dev/null')),
  },
  {
    id: 'chown_recursive',
    matches: anyCommand((c) =>
      follows(c, named('chown', 'chgrp'), (_lower, index) =>
        /^(?:-[A-Za-z]*R[A-Za-z]*|--recursive)$/.test(c.tokens[index] ?? ''),
      ),
    ),
  },
  {
    id: 'chmod_777_recursive',
    matches: anyCommand(
      (c) =>
        follows(c, named('chmod'), (_lower, index) =>
          /^(?:-[A-Za-z]*R[A-Za-z]*|--recursive)$/.test(c.tokens[index] ?? ''),
        ) && follows(c, named('chmod'), is('777', '0777', 'a+rwx')),
    ),
  },
  // git that loses work or rewrites remotes.
  {
    id: 'git_force_push',
    matches: anyCommand((c) =>
      follows(c, named('git'), is('push'), (lower) =>
        /^(?:--force(?:-with-lease)?(?:=.*)?|--mirror|--delete|--prune|-[a-z]*[fd][a-z]*|[+:].+)$/.test(
          lower,
        ),
      ),
    ),
  },
  {
    id: 'git_reset_hard',
    matches: anyCommand((c) => follows(c, named('git'), is('reset'), is('--hard'))),
  },
  {
    id: 'git_clean_force',
    matches: anyCommand((c) =>
      follows(c, named('git'), is('clean'), (lower) => /^(?:-[a-z]*f|--force$)/.test(lower)),
    ),
  },
  {
    id: 'git_discard',
    matches: anyCommand((c) => {
      if (!follows(c, named('git'))) return false
      const pathAll = is('.', ':/', '*', '-f', '--force')
      return (
        follows(c, named('git'), is('branch'), (_lower, i) =>
          /^-[A-Za-z]*D/.test(c.tokens[i] ?? ''),
        ) ||
        follows(c, named('git'), is('checkout'), pathAll) ||
        follows(c, named('git'), is('restore'), pathAll) ||
        follows(c, named('git'), is('reflog'), is('expire', 'delete')) ||
        follows(c, named('git'), is('stash'), is('drop', 'clear')) ||
        follows(c, named('git'), is('filter-repo', 'filter-branch'))
      )
    }),
  },
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
  { id: 'sql_update_without_where', matches: updatesWithoutWhere },
  { id: 'mkfs', matches: pattern(String.raw`\bmkfs(?:\.\w+)?\b`) },
  {
    id: 'dd_write',
    matches: anyCommand((c) => follows(c, named('dd'), (lower) => lower.startsWith('of='))),
  },
  // Code from elsewhere, run unseen.
  {
    id: 'pipe_to_shell',
    matches: anyPipeline((pipeline) => {
      const from = pipeline.findIndex((c) => programIndex(c, DOWNLOADERS) !== -1)
      return (
        from !== -1 && pipeline.slice(from + 1).some((c) => programIndex(c, INTERPRETERS) !== -1)
      )
    }),
  },
  {
    id: 'pipe_into_shell',
    matches: anyPipeline((pipeline) =>
      pipeline.slice(1).some((c) => {
        const at = programIndex(c, INTERPRETERS)
        return at !== -1 && readsStdin(c, at)
      }),
    ),
  },
  {
    id: 'download_and_run',
    matches: (text) =>
      /[<$]\(\s{0,8}(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i.test(text) ||
      /\b(?:iex|invoke-expression)\b\s{0,8}[($]{0,3}\s{0,8}(?:iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod|new-object)\b/i.test(
        text,
      ) ||
      downloadsThenRuns(text),
  },
  { id: 'inline_code', matches: anyCommand(runsInlineCode) },
  {
    id: 'env_exfiltration',
    matches: (text) =>
      anyPipeline((pipeline) => {
        const dump = pipeline.findIndex((c) => {
          const at = programIndex(c, ['env', 'printenv', 'set', 'export'])
          return at !== -1 && c.tokens.slice(at + 1).every((token) => token.startsWith('-'))
        })
        return dump !== -1 && pipeline.slice(dump + 1).some((c) => programIndex(c, NETWORK) !== -1)
      })(text) ||
      anyCommand(
        (c) =>
          programIndex(c, NETWORK) !== -1 &&
          /\$\(\s{0,8}(?:env|printenv|set|export -p)\s{0,8}\)|`\s{0,8}(?:env|printenv)\s{0,8}`/.test(
            c.raw,
          ),
      )(text),
  },
  // The whole environment (tokens, keys) printed into the transcript.
  {
    id: 'env_dump',
    matches: anyCommand((c) => {
      const at = programIndex(c, ['env', 'printenv'])
      if (at !== -1 && c.tokens.slice(at + 1).every((token) => token.startsWith('-'))) return true
      return follows(c, named('get-childitem', 'gci', 'ls', 'dir'), is('env:', 'env:*', 'env:*'))
    }),
  },
  // Processes and machines.
  {
    id: 'mass_kill',
    matches: anyCommand(
      (c) =>
        programIndex(c, ['pkill', 'killall']) !== -1 ||
        follows(c, named('kill'), (lower) => lower.startsWith('-'), is('-1')) ||
        follows(c, named('kill'), is('--'), is('-1')) ||
        follows(c, named('taskkill'), is('/im')),
    ),
  },
  { id: 'privilege_escalation', matches: pattern(String.raw`\b(?:sudo|doas|runas)\b`) },
  {
    id: 'shutdown',
    matches: pattern(
      String.raw`\b(?:shutdown|reboot|poweroff|halt|stop-computer|restart-computer)\b`,
    ),
  },
  // Infrastructure and publishing.
  {
    id: 'infra_destroy',
    matches: anyCommand(
      (c) =>
        follows(c, named('terraform', 'tofu'), is('destroy', '-destroy')) ||
        follows(c, named('kubectl', 'oc'), is('delete', 'drain')) ||
        follows(c, named('aws'), is('s3'), is('rm', 'rb')) ||
        follows(c, named('aws'), (lower) => /^(?:delete|terminate)-/.test(lower)) ||
        follows(c, named('gcloud', 'az'), is('delete')) ||
        follows(c, named('docker', 'podman'), is('prune')) ||
        follows(c, named('docker', 'podman'), is('volume'), is('rm')) ||
        follows(c, named('gh'), is('repo', 'release'), is('delete')) ||
        follows(c, named('helm'), is('uninstall', 'delete')),
    ),
  },
  {
    id: 'package_publish',
    matches: anyCommand((c) =>
      c.names.some((name, index) => {
        const next = c.lower.slice(index + 1).find((token) => !token.startsWith('-'))
        switch (name) {
          case 'npm':
          case 'pnpm':
          case 'yarn':
          case 'bun':
          case 'cargo':
          case 'poetry':
          case 'uv':
            return next === 'publish' || next === 'unpublish'
          case 'twine':
            return next === 'upload'
          case 'gem':
            return next === 'push'
          default:
            return false
        }
      }),
    ),
  },
  // Windows.
  {
    id: 'powershell_recursive_delete',
    matches: (text) =>
      anyCommand((c) => follows(c, named(...PS_DELETERS), isRecurseFlag))(text) ||
      anyPipeline((pipeline) => {
        const list = pipeline.findIndex((c) => follows(c, named(...PS_LISTERS), isRecurseFlag))
        return (
          list !== -1 && pipeline.slice(list + 1).some((c) => programIndex(c, PS_DELETERS) !== -1)
        )
      })(text),
  },
  {
    id: 'windows_recursive_delete',
    matches: anyCommand((c) => follows(c, named('rd', 'rmdir', 'del', 'erase'), is('/s'))),
  },
  {
    id: 'windows_wildcard_delete',
    matches: anyCommand((c) => {
      const at = programIndex(c, ['del', 'erase'])
      return at !== -1 && c.tokens.slice(at + 1).some((token) => token.includes('*'))
    }),
  },
  { id: 'windows_format', matches: pattern(String.raw`\bformat(?:\.com)?\s+[a-z]:`) },
  {
    id: 'windows_disk',
    matches: anyCommand(
      (c) =>
        programIndex(c, [
          'format-volume',
          'clear-disk',
          'initialize-disk',
          'remove-partition',
          'diskpart',
        ]) !== -1 ||
        follows(c, named('vssadmin', 'wbadmin'), is('delete')) ||
        follows(c, named('cipher'), (lower) => lower.startsWith('/w')),
    ),
  },
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
