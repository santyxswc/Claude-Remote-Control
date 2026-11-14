/**
 * The session controllers with a fake process runner: nothing here starts a
 * real `tmux`. Only the real runner's own tests start a program: bun itself.
 */
import { describe, expect, test } from 'bun:test'
import { createSessionController } from '../../../src/adapters/session/createSessionController.ts'
import { NoopSessionController } from '../../../src/adapters/session/NoopSessionController.ts'
import {
  type ProcessResult,
  type ProcessRunner,
  spawnProcess,
} from '../../../src/adapters/session/processRunner.ts'
import {
  isTmuxPaneId,
  TMUX_TIMEOUT_MS,
  TmuxSessionController,
} from '../../../src/adapters/session/TmuxSessionController.ts'
import { MemoryLogger } from '../../fakes.ts'

function fakeRunner(result: ProcessResult | Error = { exitCode: 0, timedOut: false }) {
  const calls: { argv: readonly string[]; timeoutMs: number }[] = []
  const run: ProcessRunner = async (argv, timeoutMs) => {
    calls.push({ argv, timeoutMs })
    if (result instanceof Error) throw result
    return result
  }
  return { run, calls }
}

const IN_TMUX = { TMUX: '/tmp/tmux-1000/default,1234,0', TMUX_PANE: '%3' }

describe('isTmuxPaneId', () => {
  test.each([['%0'], ['%3'], ['%123456789']])('%p is a pane id', (value) => {
    expect(isTmuxPaneId(value)).toBe(true)
  })

  test.each([
    [undefined],
    [''],
    ['%'],
    ['3'],
    ['%3 '],
    ['%3;rm -rf ~'],
    ['%3\n'],
    ['main:0.1'],
    ['-t'],
    ['%1234567890'],
  ])('%p is not', (value) => {
    expect(isTmuxPaneId(value)).toBe(false)
  })
})

describe('TmuxSessionController', () => {
  test('sends exactly Escape to its pane, as an argument array, with a timeout', async () => {
    const { run, calls } = fakeRunner()
    const controller = new TmuxSessionController({ pane: '%3', run, logger: new MemoryLogger() })
    expect(await controller.interrupt()).toBe('sent')
    expect(calls).toEqual([
      { argv: ['tmux', 'send-keys', '-t', '%3', 'Escape'], timeoutMs: TMUX_TIMEOUT_MS },
    ])
  })

  test('a non-zero exit, a timeout or a missing tmux is a failure, never a throw', async () => {
    for (const result of [
      { exitCode: 1, timedOut: false },
      { exitCode: null, timedOut: true },
      new Error('ENOENT: tmux'),
    ]) {
      const logger = new MemoryLogger()
      const { run } = fakeRunner(result)
      const controller = new TmuxSessionController({ pane: '%3', run, logger })
      expect(await controller.interrupt()).toBe('failed')
      expect(logger.entries.at(-1)?.level).toBe('warn')
    }
  })

  test('refuses to be built for anything but a pane id', () => {
    const { run } = fakeRunner()
    expect(
      () => new TmuxSessionController({ pane: '%3; kill', run, logger: new MemoryLogger() }),
    ).toThrow()
  })
})

describe('createSessionController', () => {
  const build = (platform: NodeJS.Platform, env: Record<string, string | undefined>) =>
    createSessionController({ platform, env, run: fakeRunner().run, logger: new MemoryLogger() })

  test.each([['linux'], ['darwin'], ['freebsd']] as const)(
    'tmux on %s inside a pane',
    (platform) => {
      expect(build(platform, IN_TMUX)).toBeInstanceOf(TmuxSessionController)
    },
  )

  test.each([
    ['linux', {}],
    ['linux', { TMUX: IN_TMUX.TMUX }],
    ['linux', { TMUX_PANE: '%3' }],
    ['linux', { TMUX: '', TMUX_PANE: '%3' }],
    ['linux', { TMUX: IN_TMUX.TMUX, TMUX_PANE: 'bogus' }],
    ['win32', IN_TMUX],
    ['darwin', {}],
  ] as const)('%s with %p: no-op', async (platform, env) => {
    const controller = build(platform, env)
    expect(controller).toBeInstanceOf(NoopSessionController)
    expect(await controller.interrupt()).toBe('unavailable')
  })
})

describe('spawnProcess (with bun itself, never tmux)', () => {
  test('reports the exit code', async () => {
    const result = await spawnProcess([process.execPath, '-e', 'process.exit(3)'], 5_000)
    expect(result).toEqual({ exitCode: 3, timedOut: false })
  })

  test('adds extra environment variables to the child', async () => {
    const script = "process.exit(process.env.TB_PROBE === 'a b;c' && process.env.PATH ? 0 : 9)"
    expect(
      await spawnProcess([process.execPath, '-e', script], 5_000, { env: { TB_PROBE: 'a b;c' } }),
    ).toEqual({ exitCode: 0, timedOut: false })
  })

  test('kills a program that outlives the timeout', async () => {
    const started = performance.now()
    const result = await spawnProcess([process.execPath, '-e', 'setTimeout(() => {}, 30000)'], 50)
    expect(result).toEqual({ exitCode: null, timedOut: true })
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})
