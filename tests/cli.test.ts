/**
 * The CLI composition root, spawned as a user runs it. Only the state
 * directory rules are checked here; each command has its own tests.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { messagesFor } from '../src/application/i18n/messages.ts'
import { makeTempDir, removeTempDir } from './tempDir.ts'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

let cwd: string
beforeEach(() => {
  cwd = makeTempDir()
})
afterEach(() => removeTempDir(cwd))

test.each([
  ['TELEGRAM_BRIDGE_HOME', 'relative-state'],
  ['CLAUDE_CONFIG_DIR', 'relative-config'],
])(
  'L3: a relative %s fails loudly and creates nothing in the working directory',
  async (variable, value) => {
    const child = Bun.spawn([process.execPath, CLI, 'access', 'list'], {
      cwd,
      env: {
        ...process.env,
        TELEGRAM_BRIDGE_HOME: '',
        CLAUDE_CONFIG_DIR: join(cwd, 'unused'),
        TELEGRAM_BRIDGE_LOCALE: 'en',
        [variable]: value,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exitCode).toBe(1)
    expect(stderr).toContain(messagesFor('en').invalidStateDir(variable))
    expect(existsSync(join(cwd, value))).toBe(false)
    expect(existsSync(join(cwd, 'unused'))).toBe(false)
  },
)
