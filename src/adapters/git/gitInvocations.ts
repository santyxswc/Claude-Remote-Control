/**
 * Every git command line the bridge can run (F8), and nothing else: the
 * adapter has no way to build another one. All of them only read. Each is
 * hardened against repository configuration that would run a program:
 *
 * - `--no-pager`: `core.pager` / `GIT_PAGER` are never started.
 * - `--no-optional-locks` (and `GIT_OPTIONAL_LOCKS=0`): `status` does not
 *   refresh and write the index, so nothing (such as a `post-index-change`
 *   hook) follows from a write.
 * - `--literal-pathspecs` (and `GIT_LITERAL_PATHSPECS=1`): the path filter is
 *   a literal path, never a glob or pathspec magic.
 * - `-c core.fsmonitor=false`: a `core.fsmonitor` hook command is not run.
 * - `-c core.hooksPath=<null device>`: no hook can be found.
 * - `-c filter.<name>.{clean,smudge,process}=` and `.required=false` for every
 *   filter driver the configuration defines: `status` and `diff` run clean
 *   filters on changed files; an empty command disables the driver.
 * - `diff --no-ext-diff`: no external diff driver (`diff.external`,
 *   `diff.<driver>.command`, `GIT_EXTERNAL_DIFF`).
 * - `diff --no-textconv`: no text conversion filter (`diff.<driver>.textconv`).
 * - `--ignore-submodules=dirty`: no git process is started inside submodules.
 * - `-c protocol.allow=never` and `GIT_NO_LAZY_FETCH=1`: in a partial clone
 *   `diff` would fetch a missing object from the promisor remote, and with it
 *   run `core.sshCommand`, `remote.<name>.uploadpack` or a remote helper. No
 *   transport is allowed, and git 2.45+ does not even try.
 * - `--no-color`, `-c color.ui=false`, `-c core.quotePath=false`: plain output.
 *
 * Nothing here touches the network (no fetch, no remote), and the process
 * gets a scrubbed environment (`gitEnvironment`).
 */

export type GitInvocation =
  | 'is_work_tree'
  | 'list_filters'
  | 'status'
  | 'staged_numstat'
  | 'unstaged_numstat'
  | 'staged_patch'
  | 'unstaged_patch'

export const GIT_INVOCATIONS: readonly GitInvocation[] = [
  'is_work_tree',
  'list_filters',
  'status',
  'staged_numstat',
  'unstaged_numstat',
  'staged_patch',
  'unstaged_patch',
]

export interface GitArgvOptions {
  /** `os.devNull`: `/dev/null`, or `\\.\nul` on Windows. */
  readonly devNull: string
  /** Filter driver names found in the configuration, to disable. */
  readonly filters: readonly string[]
  /** A literal path from `parseDiffPathFilter`, placed after `--`. */
  readonly pathFilter?: string
}

/** A filter name we can override safely with `-c`: `-c` splits at the first `=`. */
export function isOverridableFilterName(name: string): boolean {
  return name !== '' && !name.includes('=') && !/[\r\n\0]/.test(name)
}

const DIFF_FLAGS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--ignore-submodules=dirty',
] as const

/** The arguments after the git executable. Throws for a filter name that cannot be overridden. */
export function gitArgv(invocation: GitInvocation, options: GitArgvOptions): string[] {
  const base = [
    '--no-pager',
    '--no-optional-locks',
    '--literal-pathspecs',
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${options.devNull}`,
    '-c',
    'core.quotePath=false',
    '-c',
    'color.ui=false',
    '-c',
    'protocol.allow=never',
    ...options.filters.flatMap(filterOverrides),
  ]
  const paths = options.pathFilter === undefined ? [] : ['--', options.pathFilter]
  switch (invocation) {
    case 'is_work_tree':
      return [...base, 'rev-parse', '--is-inside-work-tree']
    case 'list_filters':
      return [...base, 'config', '--null', '--name-only', '--get-regexp', '^filter\\.']
    case 'status':
      return [
        ...base,
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=normal',
        '--ignore-submodules=dirty',
        ...paths,
      ]
    case 'staged_numstat':
      return [...base, 'diff', '--cached', '--numstat', '-z', ...DIFF_FLAGS, ...paths]
    case 'unstaged_numstat':
      return [...base, 'diff', '--numstat', '-z', ...DIFF_FLAGS, ...paths]
    case 'staged_patch':
      return [...base, 'diff', '--cached', ...DIFF_FLAGS, ...paths]
    case 'unstaged_patch':
      return [...base, 'diff', ...DIFF_FLAGS, ...paths]
  }
}

function filterOverrides(name: string): string[] {
  if (!isOverridableFilterName(name)) throw new Error('a filter driver name cannot be overridden')
  return [
    ...['clean', 'smudge', 'process'].flatMap((key) => ['-c', `filter.${name}.${key}=`]),
    // A required driver whose command is empty would make git abort instead of skipping it.
    '-c',
    `filter.${name}.required=false`,
  ]
}

/** Filter driver names in `git config --null --name-only --get-regexp '^filter\.'` output. */
export function filterNames(listing: string): string[] {
  const names = new Set<string>()
  for (const key of listing.split('\0')) {
    if (!key.startsWith('filter.')) continue
    const end = key.lastIndexOf('.')
    if (end > 'filter.'.length - 1) names.add(key.slice('filter.'.length, end))
  }
  return [...names]
}

/** Variables kept from the channel's environment (matched case-insensitively, for Windows). */
const INHERITED = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Where the owner keeps git's own configuration.
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
])

/**
 * The whole environment git runs with: the few variables it needs to find
 * itself and the owner's configuration, plus the hardening ones. Everything
 * else, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_EXTERNAL_DIFF`,
 * `GIT_PAGER`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, askpass and SSH
 * variables included, is dropped.
 */
export function gitEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && INHERITED.has(key.toUpperCase())) env[key] = value
  }
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1',
  }
}
