import { describe, expect, test } from 'bun:test'
import {
  CLI_INVOCATION,
  isAffirmative,
  messagesFor,
  parseLocale,
} from '../../src/application/i18n/messages.ts'

test('Spanish is the default; en and es are recognised', () => {
  expect(parseLocale(undefined)).toBe('es')
  expect(parseLocale('')).toBe('es')
  expect(parseLocale('fr')).toBe('es')
  expect(parseLocale(' EN ')).toBe('en')
  expect(parseLocale('es')).toBe('es')
})

test('both catalogs define the same messages', () => {
  expect(Object.keys(messagesFor('en')).sort()).toEqual(Object.keys(messagesFor('es')).sort())
})

test('claimants are shown id first, then the quoted name and the handle on labelled lines', () => {
  const view = { displayName: 'Alice A', username: 'alice', id: '111' }
  expect(messagesFor('en').pairClaimedBy(view)).toBe(
    'Code received from:\n  Telegram id: 111\n  Name: "Alice A"\n  Username: @alice',
  )
  expect(messagesFor('es').pairClaimedBy({ ...view, username: undefined })).toBe(
    'Código recibido de:\n  Id de Telegram: 111\n  Nombre: "Alice A"\n  Usuario: (ninguno)',
  )
})

test('names and handles are sanitized when rendered, even from rows stored before the fix', () => {
  const en = messagesFor('en')
  // The auditor's cases: a name posing as another account, and terminal escape sequences.
  const spoof = {
    id: '999',
    username: 'x\u{202e}',
    displayName:
      'x\u001b[2K\u001b[1A\u001b[2KCode received from: Santiago\u{202e} (@santi_real)\n  Telegram id: 12345678\u001b[8m',
  }
  const shown = en.pairClaimedBy(spoof)
  // Only the layout's own line breaks.
  expect(shown).not.toMatch(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u{202a}-\u{202e}\u{2066}-\u{2069}]/u,
  )
  const lines = shown.split('\n')
  expect(lines).toHaveLength(4)
  expect(lines[1]).toBe('  Telegram id: 999')
  expect(lines[2]?.startsWith('  Name: "')).toBe(true)
  expect(lines[3]).toBe('  Username: (none)')
  for (const text of [
    en.pairConfirmed(spoof),
    en.accessListRow(spoof, '2026-01-01T00:00:00.000Z'),
  ]) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u{202a}-\u{202e}\u{2066}-\u{2069}]/u)
    expect(text).toContain('999')
  }
})

test.each([['s'], ['Sí'], ['si'], ['y'], [' YES ']])('%p is a yes', (answer) => {
  expect(isAffirmative(answer)).toBe(true)
})

test.each([[''], ['n'], ['no'], ['sure'], ['yes please']])('%p is not a yes', (answer) => {
  expect(isAffirmative(answer)).toBe(false)
})

describe('item 2: one way to invoke the CLI, and it works without anything on PATH', () => {
  const BARE =
    /telegram-bridge (?:init|pair|access|stop|resume)\b|Usage: telegram-bridge|Uso: telegram-bridge/
  test.each([['es'], ['en']] as const)(
    '%s: no hint names a bare `telegram-bridge <command>`',
    (locale) => {
      const m = messagesFor(locale)
      const shown = [
        ...Object.values(m).filter((value): value is string => typeof value === 'string'),
        m.brakeStopReason({
          source: undefined,
          since: undefined,
          reason: undefined,
          flagPath: '/x',
        }),
        m.brakeStopReason({ source: 'terminal', since: '0', reason: undefined, flagPath: '/x' }),
      ]
      for (const text of shown) expect(text).not.toMatch(BARE)
      expect(m.usage).toContain(`${CLI_INVOCATION} <`)
      expect(m.initNextStep).toContain(`${CLI_INVOCATION} pair`)
    },
  )

  test('the invocation is the package script, run from the checkout', () => {
    expect(CLI_INVOCATION).toBe('bun run bridge --')
  })
})
