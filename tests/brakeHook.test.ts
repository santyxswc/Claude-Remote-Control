/**
 * The PreToolUse brake entrypoint, spawned the way Claude Code runs it
 * (`bun src/brakeHook.ts`, the hook JSON on stdin), in every flag state.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brakeFilePath } from '../src/adapters/storage/brakeFile.ts'
import { FileBrakeFlag } from '../src/adapters/storage/FileBrakeFlag.ts'
import { brakeHookOutput } from '../src/application/hooks/brakeHookOutput.ts'
import { messagesFor } from '../src/application/i18n/messages.ts'
import { makeTempDir, removeTempDir } from './tempDir.ts'

const HOOK = join(import.meta.dir, '..', 'src', 'brakeHook.ts')
/** Generous for a loaded CI runner; locally a run takes a few tens of ms. */
const FAST_MS = 1_200

const preToolUse = JSON.stringify({
  session_id: 'abc',
  cwd: '/home/me/app',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
  tool_use_id: 'toolu_1',
})

let stateDir: string
beforeEach(() => {
  stateDir = makeTempDir()
})
afterEach(() => removeTempDir(stateDir))

async function runHook(extraEnv: Record<string, string> = {}) {
  const started = performance.now()
  const child = Bun.spawn([process.execPath, HOOK], {
    env: { ...process.env, TELEGRAM_BRIDGE_HOME: stateDir, TELEGRAM_BRIDGE_DEBUG: '', ...extraEnv },
    stdin: new Blob([preToolUse]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr, ms: performance.now() - started }
}

test('no flag: exit 0, nothing on stdout or stderr, fast, nothing created', async () => {
  const result = await runHook()
  expect(result).toMatchObject({ exitCode: 0, stdout: '', stderr: '' })
  expect(result.ms).toBeLessThan(FAST_MS)
  expect(Array.from(new Bun.Glob('*').scanSync(stateDir))).toEqual([])
})

test('no state directory at all: not braked', async () => {
  const result = await runHook({ TELEGRAM_BRIDGE_HOME: join(stateDir, 'missing') })
  expect(result).toMatchObject({ exitCode: 0, stdout: '' })
})

test('engaged: exit 0 and exactly the deny-and-stop object, in the locale', async () => {
  const record = { engagedAt: Date.UTC(2026, 10, 14, 9, 30), actor: 'telegram:42', reason: 'oops' }
  new FileBrakeFlag(stateDir).engage(record)
  const result = await runHook({ TELEGRAM_BRIDGE_LOCALE: 'en' })
  expect(result).toMatchObject({ exitCode: 0, stderr: '' })
  expect(result.ms).toBeLessThan(FAST_MS)
  expect(result.stdout).toBe(
    brakeHookOutput({ record, flagPath: brakeFilePath(stateDir) }, messagesFor('en')),
  )
  expect(JSON.parse(result.stdout)).toMatchObject({
    continue: false,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
  })
})

test('a corrupt flag fails closed: still deny and stop', async () => {
  writeFileSync(brakeFilePath(stateDir), '{"half": ')
  const result = await runHook()
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe(
    brakeHookOutput({ record: undefined, flagPath: brakeFilePath(stateDir) }, messagesFor('es')),
  )
})

test('a flag that cannot be opened fails closed', async () => {
  mkdirSync(brakeFilePath(stateDir))
  const result = await runHook()
  expect(JSON.parse(result.stdout).continue).toBe(false)
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a flag without read permission fails closed',
  async () => {
    writeFileSync(brakeFilePath(stateDir), '{}')
    chmodSync(brakeFilePath(stateDir), 0o000)
    const result = await runHook()
    expect(JSON.parse(result.stdout).continue).toBe(false)
  },
)

test('released: passes again', async () => {
  const flag = new FileBrakeFlag(stateDir)
  flag.engage({ engagedAt: 1, actor: 'terminal', reason: undefined })
  expect((await runHook()).stdout).not.toBe('')
  flag.release()
  expect(await runHook()).toMatchObject({ exitCode: 0, stdout: '' })
})

test('diagnostics only with TELEGRAM_BRIDGE_DEBUG=1, on stderr', async () => {
  const result = await runHook({ TELEGRAM_BRIDGE_DEBUG: '1' })
  expect(result).toMatchObject({ exitCode: 0, stdout: '' })
  expect(result.stderr).toContain('absent')
})

describe('L3: an invalid state directory variable', () => {
  test('a relative TELEGRAM_BRIDGE_HOME is ignored: the brake in the fallback directory still stops', async () => {
    // CLAUDE_CONFIG_DIR stands in for the default location, so ~/.claude is never touched.
    const fallback = join(stateDir, 'channels', 'telegram-bridge')
    mkdirSync(fallback, { recursive: true })
    new FileBrakeFlag(fallback).engage({ engagedAt: 1, actor: 'terminal', reason: undefined })
    for (const cwd of [stateDir, fallback]) {
      const result = await runHookIn(cwd, {
        TELEGRAM_BRIDGE_HOME: 'relative-state',
        CLAUDE_CONFIG_DIR: stateDir,
      })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ continue: false })
    }
  })

  test('a relative TELEGRAM_BRIDGE_HOME is never read from the working directory', async () => {
    // A flag where cwd-relative resolution would look, none in the fallback: not braked.
    mkdirSync(join(stateDir, 'relative-state'))
    new FileBrakeFlag(join(stateDir, 'relative-state')).engage({
      engagedAt: 1,
      actor: 'terminal',
      reason: undefined,
    })
    const result = await runHookIn(stateDir, {
      TELEGRAM_BRIDGE_HOME: 'relative-state',
      CLAUDE_CONFIG_DIR: join(stateDir, 'config'),
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: '' })
  })
})

async function runHookIn(cwd: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, HOOK], {
    cwd,
    env: { ...process.env, TELEGRAM_BRIDGE_DEBUG: '', ...env },
    stdin: new Blob([preToolUse]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return { exitCode, stdout }
}
