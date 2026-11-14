import { describe, expect, test } from 'bun:test'
import { type CliContext, parseArgs, runCli } from '../../../src/adapters/cli/runCli.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { EngageBrake } from '../../../src/application/use-cases/EngageBrake.ts'
import { ResumeSession } from '../../../src/application/use-cases/ResumeSession.ts'
import {
  FakeClock,
  FakeTerminal,
  InMemoryAuditLog,
  InMemoryBrakeFlag,
  MemoryLogger,
} from '../../fakes.ts'
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
    [['stop'], { name: 'stop', reason: undefined }],
    [['stop', 'wrong', 'branch'], { name: 'stop', reason: 'wrong branch' }],
    [['resume'], { name: 'resume' }],
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
    [['resume', 'now']],
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
    ctx: {
      terminal,
      messages: es,
      init: fail,
      pair: fail,
      access: fail,
      brake: fail,
      hubInit: fail,
      hubRun: fail,
      hubStatus: fail,
      hubOff: fail,
      ...overrides,
    },
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

test('stop and resume run through the brake dependencies', async () => {
  const brake = new InMemoryBrakeFlag()
  const common = {
    brake,
    audit: new InMemoryAuditLog(),
    clock: new FakeClock(),
    logger: new MemoryLogger(),
  }
  const { terminal, ctx } = context({
    brake: () => ({
      terminal,
      messages: es,
      engage: new EngageBrake(common),
      resume: new ResumeSession(common),
    }),
  })
  expect(await runCli(['stop', 'lunch', 'break'], ctx)).toBe(0)
  expect(brake.record?.reason).toBe('lunch break')
  expect(await runCli(['resume'], ctx)).toBe(0)
  expect(brake.status()).toEqual({ engaged: false })
  expect(terminal.out).toEqual([es.cliStopEngaged, es.cliResumeReleased])
})
