import { expect, test } from 'bun:test'
import { type InitCommandDeps, runInit } from '../../../src/adapters/cli/initCommand.ts'
import {
  BotUnreachableError,
  InvalidBotTokenError,
  TerminalUnavailableError,
} from '../../../src/application/errors.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import type { BotIdentityProbe } from '../../../src/application/ports/BotIdentityProbe.ts'
import { InitBot } from '../../../src/application/use-cases/InitBot.ts'
import { FakeClock, FakeTerminal, InMemoryAuditLog } from '../../fakes.ts'
import { TEST_TOKEN } from '../../fakeTelegram.ts'

const en = messagesFor('en')

function setup(probe: BotIdentityProbe = { probe: async () => ({ id: '1', username: 'my_bot' }) }) {
  const terminal = new FakeTerminal()
  const saved: { token?: string } = {}
  const deps: InitCommandDeps = {
    terminal,
    messages: en,
    tokenOverriddenByEnv: false,
    initBot: new InitBot({
      probe,
      tokens: { load: () => saved.token, save: (t) => (saved.token = t) },
      identities: { load: () => undefined, save: () => {} },
      audit: new InMemoryAuditLog(),
      clock: new FakeClock(),
    }),
  }
  return { terminal, saved, deps }
}

test('asks for the token without echo, validates and saves it', async () => {
  const s = setup()
  s.terminal.secret = `  ${TEST_TOKEN}\n`

  expect(await runInit(s.deps, false)).toBe(0)

  expect(s.terminal.prompts).toEqual([en.initTokenPrompt])
  expect(s.saved.token).toBe(TEST_TOKEN)
  expect(s.terminal.out).toEqual([en.initValidating, en.initDone('my_bot'), en.initNextStep])
  expect(s.terminal.text).not.toContain(TEST_TOKEN)
})

test('--token-stdin reads the token from the pipe', async () => {
  const s = setup()
  s.terminal.piped = `${TEST_TOKEN}\n`
  expect(await runInit(s.deps, true)).toBe(0)
  expect(s.saved.token).toBe(TEST_TOKEN)
})

test('warns when the environment variable will override the saved token', async () => {
  const s = setup()
  s.terminal.secret = TEST_TOKEN
  expect(await runInit({ ...s.deps, tokenOverriddenByEnv: true }, false)).toBe(0)
  expect(s.terminal.out).toContain(en.initEnvOverride)
})

test.each([
  [false, en.initNeedsTerminal],
  [true, en.initStdinIsTerminal],
])('without a usable terminal (stdin=%p) it explains what to do', async (fromStdin, message) => {
  const s = setup()
  s.terminal.secret = new TerminalUnavailableError()
  s.terminal.piped = new TerminalUnavailableError()
  expect(await runInit(s.deps, fromStdin)).toBe(1)
  expect(s.terminal.err).toEqual([message])
})

test('an empty token fails before any validation', async () => {
  const s = setup({
    probe: async () => {
      throw new Error('must not be called')
    },
  })
  s.terminal.secret = '   '
  expect(await runInit(s.deps, false)).toBe(1)
  expect(s.terminal.err).toEqual([en.initTokenEmpty])
})

test.each([
  [new InvalidBotTokenError(), en.initInvalidToken],
  [new BotUnreachableError('ECONNREFUSED'), en.initUnreachable('ECONNREFUSED')],
])(
  'a failed validation (%p) saves nothing and never prints the token',
  async (failure, message) => {
    const s = setup({
      probe: async () => {
        throw failure
      },
    })
    s.terminal.secret = TEST_TOKEN
    expect(await runInit(s.deps, false)).toBe(1)
    expect(s.terminal.err).toEqual([message])
    expect(s.saved.token).toBeUndefined()
    expect(s.terminal.text).not.toContain(TEST_TOKEN)
  },
)
