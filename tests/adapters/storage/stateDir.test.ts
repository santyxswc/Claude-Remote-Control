import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultStateDir, resolveStateDir } from '../../../src/adapters/storage/stateDir.ts'

const home = join('base', 'home')

test('defaults to <home>/.claude/channels/telegram-bridge', () => {
  expect(resolveStateDir({}, home)).toBe(join(home, '.claude', 'channels', 'telegram-bridge'))
})

test('TELEGRAM_BRIDGE_HOME overrides the default', () => {
  const custom = resolve('somewhere', 'state')
  expect(resolveStateDir({ TELEGRAM_BRIDGE_HOME: custom }, home)).toBe(custom)
})

test('a relative TELEGRAM_BRIDGE_HOME is made absolute', () => {
  expect(resolveStateDir({ TELEGRAM_BRIDGE_HOME: 'state' }, home)).toBe(resolve('state'))
})

test('a blank TELEGRAM_BRIDGE_HOME is ignored', () => {
  expect(resolveStateDir({ TELEGRAM_BRIDGE_HOME: ' ' }, home)).toBe(
    join(home, '.claude', 'channels', 'telegram-bridge'),
  )
})

test('defaultStateDir uses the process environment and home directory', () => {
  const expected = resolveStateDir(process.env, homedir())
  expect(defaultStateDir()).toBe(expected)
})
