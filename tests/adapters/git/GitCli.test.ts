/**
 * The read-only git adapter against real repositories (F8). Every repository
 * is created in a temp dir with its own configuration: the global and system
 * files are pointed away, user.name/email are set locally, hooks are off
 * during setup, and nothing touches the network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { GitCli } from '../../../src/adapters/git/GitCli.ts'
import {
  type CapturedOutput,
  type CapturingProcessRunner,
  spawnCapturing,
} from '../../../src/adapters/session/processRunner.ts'
import type { GitReadResult } from '../../../src/application/ports/GitRepository.ts'
import {
  commitAll as commitIn,
  GIT,
  initTestRepo,
  isolatedGitEnv,
  setupGit,
  writeIn,
} from '../../gitRepo.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

let root: string
let repo: string
let home: string
let markers: string
let env: Record<string, string>

const isolatedEnv = () => env
const git = (...args: string[]) => setupGit(repo, env, ...args)
const write = (path: string, content: string | Uint8Array) => writeIn(repo, path, content)
const initRepo = () => initTestRepo(repo, env)
const commitAll = (message: string) => commitIn(repo, env, message)

function cli(
  overrides: { cwd?: string; env?: Record<string, string>; run?: CapturingProcessRunner } = {},
) {
  return new GitCli({
    gitPath: GIT ?? undefined,
    cwd: overrides.cwd ?? repo,
    env: overrides.env ?? isolatedEnv(),
    devNull,
    run: overrides.run ?? spawnCapturing,
  })
}

function ok(result: GitReadResult) {
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`)
  if (result.changes === undefined) throw new Error('expected changes')
  return { status: result.status, changes: result.changes }
}

/** A shell command git would run: it leaves `markers/<name>` behind. */
function marker(name: string): string {
  return `echo ran > "${join(markers, name).replaceAll('\\', '/')}"`
}

beforeEach(() => {
  root = makeTempDir()
  repo = join(root, 'repo')
  home = join(root, 'home')
  markers = join(root, 'markers')
  mkdirSync(markers)
  env = isolatedGitEnv(home)
})
afterEach(() => removeTempDir(root))

describe.skipIf(GIT === null)('GitCli against real repositories', () => {
  test('not a work tree', async () => {
    mkdirSync(repo)
    expect(await cli().read({ withChanges: true })).toEqual({ kind: 'not_a_repo' })
  })

  test('git not installed', async () => {
    const adapter = new GitCli({
      gitPath: undefined,
      cwd: root,
      env: {},
      devNull,
      run: () => {
        throw new Error('never spawned')
      },
    })
    expect(await adapter.read({ withChanges: true })).toEqual({
      kind: 'unavailable',
      reason: 'git_missing',
    })
  })

  test('a clean tree: branch and no changes', async () => {
    initRepo()
    write('a.txt', 'one\n')
    commitAll('init')
    const { status, changes } = ok(await cli().read({ withChanges: true }))
    expect(status.branch).toBe('main')
    expect(status.upstream).toBeUndefined()
    expect([status.staged, status.unstaged, status.untracked.length]).toEqual([0, 0, 0])
    expect(changes.staged.patch).toEqual({ text: '', cut: false })
    expect(changes.unstaged.patch).toEqual({ text: '', cut: false })
  })

  test('staged, unstaged, untracked, binary and renamed files', async () => {
    initRepo()
    write('a.txt', 'one\n')
    write('keep.txt', 'k\n')
    write('old name.txt', 'rename me\nline 2\nline 3\n')
    write('image.bin', new Uint8Array([0, 1, 2, 3, 0, 255]))
    commitAll('init')

    write('a.txt', 'one\ntwo\n')
    git('add', 'a.txt')
    write('keep.txt', 'k\nunstaged change\n')
    git('mv', 'old name.txt', 'new name.txt')
    write('image.bin', new Uint8Array([0, 9, 9, 9, 0, 255, 7]))
    git('add', 'image.bin')
    write('notes/todo.md', 'untracked\n')
    write('ñandú.txt', 'untracked too\n')

    const { status, changes } = ok(await cli().read({ withChanges: true }))
    expect(status.staged).toBe(3)
    expect(status.unstaged).toBe(1)
    expect([...status.untracked].sort()).toEqual(['notes/', 'ñandú.txt'])
    expect(changes.staged.totals).toEqual({ files: 3, insertions: 1, deletions: 0, binary: 1 })
    expect(changes.unstaged.totals).toEqual({ files: 1, insertions: 1, deletions: 0, binary: 0 })
    expect(changes.staged.patch.text).toContain('+two')
    expect(changes.staged.patch.text).toContain('rename from old name.txt')
    expect(changes.staged.patch.text).toContain('Binary files')
    expect(changes.staged.patch.text).not.toContain('\u001b[') // no color
    expect(changes.unstaged.patch.text).toContain('+unstaged change')
  })

  test('the path filter narrows status and diff, and is literal', async () => {
    initRepo()
    write('src/a.ts', 'a\n')
    write('docs/b.md', 'b\n')
    write('[ab].txt', 's\n')
    write('a.txt', 'x\n')
    commitAll('init')
    write('src/a.ts', 'a2\n')
    write('docs/b.md', 'b2\n')
    write('[ab].txt', 's2\n')
    write('a.txt', 'x2\n')

    const src = ok(await cli().read({ withChanges: true, pathFilter: 'src' }))
    expect(src.status.unstaged).toBe(1)
    expect(src.changes.unstaged.patch.text).toContain('src/a.ts')
    expect(src.changes.unstaged.patch.text).not.toContain('docs/b.md')

    // `[ab]` is not a glob: only the file literally named `[ab].txt`, never `a.txt`.
    const literal = ok(await cli().read({ withChanges: true, pathFilter: '[ab].txt' }))
    expect(literal.changes.unstaged.totals.files).toBe(1)
    expect(literal.changes.unstaged.patch.text).not.toContain('a.txt')
  })

  test('ahead/behind come from local refs', async () => {
    initRepo()
    write('a.txt', '1\n')
    commitAll('one')
    git('branch', 'base')
    git('branch', '--set-upstream-to=base')
    write('a.txt', '2\n')
    commitAll('two')
    const result = await cli().read({ withChanges: false })
    if (result.kind !== 'ok') throw new Error(result.kind)
    expect(result.status.upstream).toEqual({ name: 'base', ahead: 1, behind: 0 })
    expect(result.changes).toBeUndefined()
  })

  describe('a hostile repository configuration never runs anything', () => {
    /**
     * Every vector at once (`all`), or only the diff drivers (`drivers`): `diff.external` wins
     * over them, and a failing required filter aborts `git diff` before they would run.
     */
    function hostileRepo(variant: 'all' | 'drivers'): void {
      initRepo()
      write('a.txt', 'one\n')
      write('b.conv', 'conv\n')
      write('c.flt', 'filtered\n')
      write('d.drv', 'driver\n')
      write('e.proc', 'process\n')
      write(
        '.gitattributes',
        '*.conv diff=conv\n*.flt filter=evil\n*.drv diff=drv\n*.proc filter=proc\n',
      )
      commitAll('init')
      // Staged before the hostile configuration exists, so setup runs none of it.
      write('a.txt', 'one\nchanged\n')
      git('add', 'a.txt')

      const hooks = join(root, 'evil-hooks')
      mkdirSync(hooks)
      for (const hook of [
        'post-index-change',
        'pre-commit',
        'post-checkout',
        'reference-transaction',
        'fsmonitor-watchman',
      ]) {
        const path = join(hooks, hook)
        writeFileSync(path, `#!/bin/sh\n${marker(`hook-${hook}`)}\n`)
        chmodSync(path, 0o755)
      }
      writeFileSync(
        join(repo, '.git', 'hooks', 'post-index-change'),
        `#!/bin/sh\n${marker('hook-default')}\n`,
      )
      chmodSync(join(repo, '.git', 'hooks', 'post-index-change'), 0o755)

      const config: [string, string][] = [
        ['diff.drv.command', marker('diff-driver')],
        ['diff.conv.textconv', marker('textconv')],
        ['core.fsmonitor', marker('fsmonitor')],
        ['core.hooksPath', hooks.replaceAll('\\', '/')],
        ['core.pager', marker('pager')],
        ['pager.diff', marker('pager-diff')],
        ['pager.status', marker('pager-status')],
        ['diff.colorMoved', 'zebra'],
      ]
      if (variant === 'all') {
        config.push(
          ['diff.external', marker('diff-external')],
          ['filter.evil.clean', marker('filter-clean')],
          ['filter.evil.smudge', marker('filter-smudge')],
          ['filter.evil.required', 'true'],
          ['filter.proc.process', marker('filter-process')],
          ['filter.proc.required', 'true'],
        )
      }
      for (const [key, value] of config) git('config', key, value)

      // Dirty every attributed file.
      write('b.conv', 'conv\nchanged\n')
      write('c.flt', 'filtered\nchanged\n')
      write('d.drv', 'driver\nchanged\n')
      write('e.proc', 'process\nchanged\n')
      write('new.flt', 'untracked filtered\n')
    }

    test.each([
      ['all', ['diff-external', 'filter-clean', 'filter-process']],
      ['drivers', ['diff-driver', 'textconv']],
    ])('control (%p): the configuration does run %p under a plain git', (variant, vectors) => {
      hostileRepo(variant as 'all' | 'drivers')
      const env = isolatedEnv()
      for (const args of [['status'], ['diff'], ['diff', '--cached'], ['add', 'c.flt']]) {
        Bun.spawnSync([GIT ?? 'git', '-C', repo, ...args], {
          env,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        })
      }
      const ran = readdirSync(markers)
      // The test would prove nothing if these vectors were inert here.
      for (const vector of vectors) {
        expect(ran).toContain(vector)
      }
    })

    test.each(['all', 'drivers'] as const)(
      'the adapter (%p): status and every diff, with and without a path, leave no marker',
      async (variant) => {
        hostileRepo(variant)
        expect(readdirSync(markers)).toEqual([]) // setup itself ran nothing

        const env = {
          ...isolatedEnv(),
          // A hostile parent environment is scrubbed too.
          GIT_EXTERNAL_DIFF: marker('env-external-diff'),
          GIT_PAGER: marker('env-pager'),
          PAGER: marker('env-pager2'),
          GIT_CONFIG_PARAMETERS: `'diff.external'='${marker('env-config-parameters')}'`,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'diff.external',
          GIT_CONFIG_VALUE_0: marker('env-config-count'),
        }
        const adapter = cli({ env })
        for (const pathFilter of [undefined, '.', 'c.flt', 'b.conv', 'd.drv', 'e.proc']) {
          const result = ok(
            await adapter.read({
              withChanges: true,
              ...(pathFilter === undefined ? {} : { pathFilter }),
            }),
          )
          if (pathFilter === undefined) {
            expect(result.status.staged).toBe(1)
            expect(result.status.unstaged).toBe(4)
            expect(result.status.untracked).toEqual(['new.flt'])
            expect(result.changes.staged.totals.files).toBe(1)
            expect(result.changes.unstaged.totals.files).toBe(4)
            // The raw content is shown, not a conversion.
            expect(result.changes.unstaged.patch.text).toContain('+changed')
          }
        }
        expect(await adapter.read({ withChanges: false })).toMatchObject({ kind: 'ok' })
        expect(readdirSync(markers)).toEqual([])
        expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false)
      },
    )

    test('a filter driver name that cannot be overridden: refused, nothing runs', async () => {
      initRepo()
      write('a.txt', 'one\n')
      commitAll('init')
      // `-c filter.a=b.clean=` would be parsed at the first `=`: not overridable.
      appendFileSync(
        join(repo, '.git', 'config'),
        `[filter "a=b"]\n\tclean = ${marker('odd-filter')}\n`,
      )
      write('a.txt', 'one\ntwo\n')
      expect(await cli().read({ withChanges: true })).toEqual({
        kind: 'unavailable',
        reason: 'unsafe_config',
      })
      expect(readdirSync(markers)).toEqual([])
    })
  })
})

describe('GitCli caps (scripted runner)', () => {
  const NUL = '\0'
  function scripted(
    outputs: Record<string, { text: string; truncated?: boolean; exitCode?: number }>,
  ) {
    const calls: (readonly string[])[] = []
    const run: CapturingProcessRunner = async (argv, options) => {
      calls.push(argv)
      expect(options.timeoutMs).toBeGreaterThan(0)
      expect(options.cwd).toBe('/project')
      const key = argv.includes('rev-parse')
        ? 'rev-parse'
        : argv.includes('config')
          ? 'config'
          : argv.includes('status')
            ? 'status'
            : `${argv.includes('--cached') ? 'staged' : 'unstaged'}-${argv.includes('--numstat') ? 'numstat' : 'patch'}`
      const out = outputs[key] ?? { text: '' }
      const result: CapturedOutput = {
        exitCode: out.truncated === true ? null : (out.exitCode ?? 0),
        timedOut: false,
        stdout: new TextEncoder().encode(out.text),
        truncated: out.truncated ?? false,
      }
      return result
    }
    return { calls, run }
  }

  const adapter = (run: CapturingProcessRunner) =>
    new GitCli({ gitPath: '/usr/bin/git', cwd: '/project', env: {}, devNull: '/dev/null', run })

  test('a patch cut by the read cap loses its partial last line', async () => {
    const { run } = scripted({
      'rev-parse': { text: 'true\n' },
      config: { text: '', exitCode: 1 },
      status: { text: `# branch.head main${NUL}1 .M N... 1 1 1 a b f${NUL}` },
      'unstaged-patch': { text: '+line one\n+token=ABCDEFGH', truncated: true },
    })
    const result = ok(await adapter(run).read({ withChanges: true }))
    expect(result.changes.unstaged.patch).toEqual({ text: '+line one\n', cut: true })
    expect(result.changes.staged.patch).toEqual({ text: '', cut: false })
  })

  test('configured filters are disabled on every later call', async () => {
    const { calls, run } = scripted({
      'rev-parse': { text: 'true\n' },
      config: { text: `filter.lfs.clean${NUL}filter.lfs.smudge${NUL}` },
    })
    await adapter(run).read({ withChanges: true })
    // rev-parse, config, status, then the four diffs.
    expect(calls).toHaveLength(7)
    for (const argv of calls.slice(2)) {
      expect(argv).toContain('filter.lfs.clean=')
      expect(argv).toContain('filter.lfs.process=')
      expect(argv).toContain('filter.lfs.required=false')
    }
    expect(calls[0]?.[0]).toBe('/usr/bin/git')
  })

  test('a truncated filter listing is unsafe: nothing else runs', async () => {
    const { calls, run } = scripted({
      'rev-parse': { text: 'true\n' },
      config: { text: 'filter.a.clean', truncated: true },
    })
    expect(await adapter(run).read({ withChanges: true })).toEqual({
      kind: 'unavailable',
      reason: 'unsafe_config',
    })
    expect(calls).toHaveLength(2)
  })

  test('a failing git command is an error, not an empty diff', async () => {
    const { run } = scripted({
      'rev-parse': { text: 'true\n' },
      config: { text: '', exitCode: 1 },
      'staged-patch': { text: '', exitCode: 128 },
    })
    await expect(adapter(run).read({ withChanges: true })).rejects.toThrow('exited with 128')
  })
})

describe('spawnCapturing (with bun itself)', () => {
  const { PATH: SEARCH_PATH = '' } = process.env
  test('explicit cwd and env, output captured', async () => {
    const dir = makeTempDir()
    try {
      const result = await spawnCapturing(
        [
          process.execPath,
          '-e',
          'process.stdout.write(process.cwd() + "|" + process.env.TB_X + "|" + process.env.TB_Y)',
        ],
        {
          cwd: dir,
          env: { PATH: SEARCH_PATH, TB_X: 'a b;c' },
          timeoutMs: 10_000,
          maxBytes: 10_000,
        },
      )
      expect(result.exitCode).toBe(0)
      const [cwd, x, y] = new TextDecoder().decode(result.stdout).split('|')
      expect(cwd?.toLowerCase().endsWith(dir.split(/[\\/]/).at(-1)?.toLowerCase() ?? '?')).toBe(
        true,
      )
      expect(x).toBe('a b;c')
      expect(y).toBe('undefined') // the env is the whole env, nothing inherited
    } finally {
      removeTempDir(dir)
    }
  })

  test('stops reading at the cap and kills the process', async () => {
    const result = await spawnCapturing(
      [process.execPath, '-e', 'for (;;) process.stdout.write("x".repeat(65536))'],
      {
        cwd: process.cwd(),
        env: { PATH: SEARCH_PATH },
        timeoutMs: 10_000,
        maxBytes: 100_000,
      },
    )
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBe(100_000)
    expect(result.exitCode).toBeNull()
  })

  test('an aborted signal kills it', async () => {
    const abort = new AbortController()
    abort.abort()
    const result = await spawnCapturing([process.execPath, '-e', 'setTimeout(() => {}, 30000)'], {
      cwd: process.cwd(),
      env: { PATH: SEARCH_PATH },
      timeoutMs: 10_000,
      maxBytes: 1000,
      signal: abort.signal,
    })
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(false)
  })
})
