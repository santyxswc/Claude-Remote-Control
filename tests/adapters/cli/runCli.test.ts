import { describe, expect, test } from 'bun:test'
import { type CliContext, parseArgs, runCli } from '../../../src/adapters/cli/runCli.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { FakeTerminal } from '../../fakes.ts'
import { TEST_TOKEN } from '../../fakeTelegram.ts'

const es = messagesFor('es')

describe('parseArgs', () => {
  test.each([
    [['--help'], { name: 'help' }],
    [['-h'], { name: 'help' }],
    [['--', 'init'], { name: 'init', fromStdin: false }],
    [['init', '--token-stdin'], { name: 'init', fromStdin: true }],
    [['pair'], { name: 'pair' }],
    [['access', 'list'], { name: 'access-list' }],
    [['access', 'revoke', '42'], { name: 'access-revoke', id: '42' }],
  ])('%p', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected as never)
  })

  test.each([
    [[]],
    [['init', TEST_TOKEN]],
    [['init', '--token', TEST_TOKEN]],
    [['pair', 'now']],
    [['access']],
    [['access', 'revoke']],
    [['access', 'list', 'x']],
    [['nope']],
  ])('%p is a usage error', (argv) => {
    expect(parseArgs(argv)).toBeUndefined()
  })
})

function context(overrides: Partial<CliContext> = {}): { terminal: FakeTerminal; ctx: CliContext } {
  const terminal = new FakeTerminal()
  const fail = () => {
    throw new Error('dependencies must not be built')
  }
  return {
    terminal,
    ctx: { terminal, messages: es, init: fail, pair: fail, access: fail, ...overrides },
  }
}

test('--help prints usage, exits 0 and builds nothing', async () => {
  const { terminal, ctx } = context()
  expect(await runCli(['--help'], ctx)).toBe(0)
  expect(terminal.out).toEqual([es.usage])
})

test('a token passed as an argument is refused with exit 2 and never echoed', async () => {
  const { terminal, ctx } = context()
  expect(await runCli(['init', TEST_TOKEN], ctx)).toBe(2)
  expect(terminal.err).toEqual([es.unknownCommand, es.usage])
  expect(terminal.text).not.toContain(TEST_TOKEN)
})

test('unexpected errors become exit 1 with a message', async () => {
  const { terminal, ctx } = context({
    access: () => {
      throw new Error('disk full')
    },
  })
  expect(await runCli(['access', 'list'], ctx)).toBe(1)
  expect(terminal.err).toEqual([es.unexpectedError('disk full')])
})
