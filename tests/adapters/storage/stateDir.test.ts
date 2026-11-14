import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  defaultStateDir,
  ensureStateDir,
  resolveStateDir,
  writeSecretFile,
} from '../../../src/adapters/storage/stateDir.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

const home = join('base', 'home')
const defaultDir = join(home, '.claude', 'channels', 'telegram-bridge')

test('defaults to <home>/.claude/channels/telegram-bridge', () => {
  expect(resolveStateDir({}, home)).toBe(defaultDir)
})

test('TELEGRAM_BRIDGE_HOME overrides the default', () => {
  const custom = resolve('somewhere', 'state')
  expect(resolveStateDir({ TELEGRAM_BRIDGE_HOME: custom }, home)).toBe(custom)
})

test('a relative TELEGRAM_BRIDGE_HOME is made absolute', () => {
  expect(resolveStateDir({ TELEGRAM_BRIDGE_HOME: 'state' }, home)).toBe(resolve('state'))
})

test('a blank TELEGRAM_BRIDGE_HOME is ignored', () => {
  expect(resolveStateDir({ TELEGRAM_BRIDGE_HOME: ' ' }, home)).toBe(defaultDir)
})

test('CLAUDE_CONFIG_DIR replaces ~/.claude when TELEGRAM_BRIDGE_HOME is unset', () => {
  const config = resolve('cfg')
  expect(resolveStateDir({ CLAUDE_CONFIG_DIR: config }, home)).toBe(
    join(config, 'channels', 'telegram-bridge'),
  )
  expect(resolveStateDir({ CLAUDE_CONFIG_DIR: '' }, home)).toBe(defaultDir)
})

test('TELEGRAM_BRIDGE_HOME wins over CLAUDE_CONFIG_DIR', () => {
  const custom = resolve('mine')
  expect(
    resolveStateDir({ TELEGRAM_BRIDGE_HOME: custom, CLAUDE_CONFIG_DIR: resolve('cfg') }, home),
  ).toBe(custom)
})

test('defaultStateDir uses the process environment and home directory', () => {
  expect(defaultStateDir()).toBe(resolveStateDir(process.env, homedir()))
})

let dir: string
beforeEach(() => {
  dir = makeTempDir()
})
afterEach(() => removeTempDir(dir))

test('ensureStateDir creates nested directories', () => {
  const state = join(dir, 'a', 'b')
  expect(ensureStateDir(state)).toBe(state)
  expect(existsSync(state)).toBe(true)
})

test.skipIf(process.platform === 'win32')('the state directory is owner-only (0700)', () => {
  const state = join(dir, 'state')
  ensureStateDir(state)
  expect(statSync(state).mode & 0o777).toBe(0o700)
})

test('writeSecretFile writes atomically and leaves no temp file', () => {
  const path = join(dir, 'secret')
  writeSecretFile(path, 'one')
  writeSecretFile(path, 'two')
  expect(readFileSync(path, 'utf8')).toBe('two')
  expect(readdirSync(dir)).toEqual(['secret'])
})

test.skipIf(process.platform === 'win32')('secret files are owner-only (0600)', () => {
  const path = join(dir, 'secret')
  writeSecretFile(path, 'x')
  expect(statSync(path).mode & 0o777).toBe(0o600)
})
