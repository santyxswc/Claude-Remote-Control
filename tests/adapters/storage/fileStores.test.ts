import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DotEnvTokenStore } from '../../../src/adapters/storage/DotEnvTokenStore.ts'
import { JsonBotIdentityStore } from '../../../src/adapters/storage/JsonBotIdentityStore.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

const TOKEN = '123456789:AAHfake-token_for_tests_only_000000'

let dir: string
beforeEach(() => {
  dir = makeTempDir()
})
afterEach(() => removeTempDir(dir))

describe('DotEnvTokenStore', () => {
  test('has no token until one is saved', () => {
    expect(new DotEnvTokenStore(dir, {}).load()).toBeUndefined()
  })

  test('saves to .env as TELEGRAM_BOT_TOKEN=... and reads it back', () => {
    new DotEnvTokenStore(dir, {}).save(TOKEN)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(`TELEGRAM_BOT_TOKEN=${TOKEN}\n`)
    expect(new DotEnvTokenStore(dir, {}).load()).toBe(TOKEN)
  })

  test('replaces the token line and keeps other lines', () => {
    writeFileSync(join(dir, '.env'), 'OTHER=1\r\nTELEGRAM_BOT_TOKEN=old\r\n')
    new DotEnvTokenStore(dir, {}).save(TOKEN)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(`OTHER=1\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`)
  })

  test('reads quoted values and tolerates spaces', () => {
    writeFileSync(join(dir, '.env'), ` TELEGRAM_BOT_TOKEN = "${TOKEN}" \n`)
    expect(new DotEnvTokenStore(dir, {}).load()).toBe(TOKEN)
  })

  test('the environment variable overrides the file; blank does not', () => {
    new DotEnvTokenStore(dir, {}).save(TOKEN)
    const fromEnv = new DotEnvTokenStore(dir, { TELEGRAM_BOT_TOKEN: '999:override' })
    expect(fromEnv.load()).toBe('999:override')
    expect(fromEnv.overriddenByEnv).toBe(true)
    const blank = new DotEnvTokenStore(dir, { TELEGRAM_BOT_TOKEN: '  ' })
    expect(blank.load()).toBe(TOKEN)
    expect(blank.overriddenByEnv).toBe(false)
  })

  test.skipIf(process.platform === 'win32')('the .env file is owner-only (0600)', () => {
    new DotEnvTokenStore(dir, {}).save(TOKEN)
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
  })
})

describe('JsonBotIdentityStore', () => {
  test('round-trips the identity in bot.json', () => {
    const store = new JsonBotIdentityStore(dir)
    expect(store.load()).toBeUndefined()
    store.save({ id: '42', username: 'my_bot' })
    expect(JSON.parse(readFileSync(join(dir, 'bot.json'), 'utf8'))).toEqual({
      id: '42',
      username: 'my_bot',
    })
    expect(store.load()).toEqual({ id: '42', username: 'my_bot' })
  })

  test.each([['not json'], ['{"id":42}'], ['[]']])('a corrupt file %p reads as missing', (text) => {
    writeFileSync(join(dir, 'bot.json'), text)
    expect(new JsonBotIdentityStore(dir).load()).toBeUndefined()
  })
})
