/**
 * The argv allowlist (F8): every command line the git adapter can produce is
 * enumerated here and checked against what a read-only, hardened git call
 * looks like. A new invocation that writes, fetches, or drops a hardening flag fails.
 */
import { describe, expect, test } from 'bun:test'
import {
  filterNames,
  GIT_INVOCATIONS,
  type GitInvocation,
  gitArgv,
  gitEnvironment,
  isOverridableFilterName,
} from '../../../src/adapters/git/gitInvocations.ts'

const DEV_NULLS = ['/dev/null', '\\\\.\\nul']
const FILTER_SETS: readonly (readonly string[])[] = [[], ['lfs'], ['evil', 'a.b', 'with space']]
const PATHS = [undefined, '.', 'src/app.ts', 'a file.md']

/** Exactly the subcommand (and its fixed arguments) each invocation may run. */
const ALLOWED: Record<GitInvocation, readonly string[]> = {
  is_work_tree: ['rev-parse', '--is-inside-work-tree'],
  list_filters: ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'],
  status: [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=normal',
    '--ignore-submodules=dirty',
  ],
  staged_numstat: [
    'diff',
    '--cached',
    '--numstat',
    '-z',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--ignore-submodules=dirty',
  ],
  unstaged_numstat: [
    'diff',
    '--numstat',
    '-z',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--ignore-submodules=dirty',
  ],
  staged_patch: [
    'diff',
    '--cached',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--ignore-submodules=dirty',
  ],
  unstaged_patch: [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--ignore-submodules=dirty',
  ],
}

/** Takes path filters (after `--`). */
const WITH_PATHS: ReadonlySet<GitInvocation> = new Set([
  'status',
  'staged_numstat',
  'unstaged_numstat',
  'staged_patch',
  'unstaged_patch',
])

function* everyArgv() {
  for (const invocation of GIT_INVOCATIONS) {
    for (const devNull of DEV_NULLS) {
      for (const filters of FILTER_SETS) {
        for (const pathFilter of PATHS) {
          const argv = gitArgv(invocation, {
            devNull,
            filters,
            ...(pathFilter === undefined ? {} : { pathFilter }),
          })
          yield { invocation, devNull, filters, pathFilter, argv }
        }
      }
    }
  }
}

/** Splits the global options (`--x` and `-c key=value` pairs) from the subcommand. */
function split(argv: readonly string[]) {
  const globals: string[] = []
  const config: string[] = []
  let i = 0
  for (; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '-c') {
      config.push(argv[i + 1] ?? '')
      i += 1
    } else if (arg.startsWith('--')) {
      globals.push(arg)
    } else break
  }
  return { globals, config, rest: argv.slice(i) }
}

describe('git argv allowlist', () => {
  test('lists every invocation the type has', () => {
    expect(Object.keys(ALLOWED).sort()).toEqual([...GIT_INVOCATIONS].sort())
  })

  test('every argv: hardening first, then exactly the allowed read-only subcommand', () => {
    let count = 0
    for (const { invocation, devNull, filters, pathFilter, argv } of everyArgv()) {
      count += 1
      const { globals, config, rest } = split(argv)
      expect(globals).toEqual(['--no-pager', '--no-optional-locks', '--literal-pathspecs'])
      expect(config.slice(0, 5)).toEqual([
        'core.fsmonitor=false',
        `core.hooksPath=${devNull}`,
        'core.quotePath=false',
        'color.ui=false',
        'protocol.allow=never',
      ])
      // Every configured filter driver is disabled, and nothing else is set.
      expect(config.slice(5)).toEqual(
        filters.flatMap((name) => [
          `filter.${name}.clean=`,
          `filter.${name}.smudge=`,
          `filter.${name}.process=`,
          `filter.${name}.required=false`,
        ]),
      )
      const expected = [
        ...ALLOWED[invocation],
        ...(pathFilter !== undefined && WITH_PATHS.has(invocation) ? ['--', pathFilter] : []),
      ]
      expect(rest).toEqual(expected)
    }
    expect(count).toBe(
      GIT_INVOCATIONS.length * DEV_NULLS.length * FILTER_SETS.length * PATHS.length,
    )
  })

  test('no argv names a writing or networking subcommand or option', () => {
    const forbidden =
      /^(?:add|am|apply|checkout|cherry-pick|clean|clone|commit|fetch|gc|init|merge|mv|pull|push|rebase|remote|reset|restore|revert|rm|stash|submodule|switch|tag|update-index|update-ref|worktree|-o|--output.*|--ext-diff|--textconv|--exec.*|--upload-pack.*|--receive-pack.*|--add|--unset.*|--replace-all|--edit|-e|--global|--system|--file.*)$/
    for (const { argv, pathFilter } of everyArgv()) {
      for (const arg of argv) {
        if (arg === pathFilter) continue
        expect(forbidden.test(arg)).toBe(false)
      }
    }
  })

  test('the path is only ever the single argument after `--`', () => {
    for (const { argv, pathFilter } of everyArgv()) {
      if (pathFilter === undefined) {
        expect(argv).not.toContain('--')
        continue
      }
      const at = argv.indexOf(pathFilter)
      if (at === -1) continue
      expect(argv[at - 1]).toBe('--')
      expect(at).toBe(argv.length - 1)
    }
  })

  test('a filter name that cannot be overridden is refused, never passed', () => {
    for (const name of ['', 'a=b', 'a\nb', 'a\rb', 'a\0b']) {
      expect(isOverridableFilterName(name)).toBe(false)
      expect(() => gitArgv('status', { devNull: '/dev/null', filters: [name] })).toThrow()
    }
    expect(isOverridableFilterName('lfs')).toBe(true)
  })
})

describe('filterNames', () => {
  test('driver names from the config listing, deduplicated', () => {
    expect(
      filterNames(
        'filter.lfs.clean\0filter.lfs.smudge\0filter.lfs.process\0filter.lfs.required\0filter.a.b.clean\0',
      ),
    ).toEqual(['lfs', 'a.b'])
    expect(filterNames('')).toEqual([])
    expect(filterNames('core.x\0filter.\0filter.noKey\0')).toEqual([])
  })
})

describe('gitEnvironment', () => {
  test('keeps only what git needs, drops every redirecting variable, adds the hardening', () => {
    const env = gitEnvironment({
      PATH: '/usr/bin',
      Path: 'C:\\Windows',
      HOME: '/home/me',
      SystemRoot: 'C:\\Windows',
      GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_INDEX_FILE: '/x',
      GIT_EXTERNAL_DIFF: '/bin/evil',
      GIT_PAGER: '/bin/evil',
      PAGER: '/bin/evil',
      GIT_CONFIG_PARAMETERS: "'core.pager'='evil'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.pager',
      GIT_CONFIG_VALUE_0: 'evil',
      GIT_ASKPASS: '/bin/evil',
      SSH_ASKPASS: '/bin/evil',
      GIT_SSH_COMMAND: 'evil',
      GIT_OPTIONAL_LOCKS: '1',
      TELEGRAM_BOT_TOKEN: 'secret',
      UNSET: undefined,
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      Path: 'C:\\Windows',
      HOME: '/home/me',
      SystemRoot: 'C:\\Windows',
      GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_NO_LAZY_FETCH: '1',
    })
  })
})
