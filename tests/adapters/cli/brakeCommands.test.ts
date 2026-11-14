import { expect, test } from 'bun:test'
import { runResume, runStop } from '../../../src/adapters/cli/brakeCommands.ts'
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

const en = messagesFor('en')

function setup() {
  const terminal = new FakeTerminal()
  const brake = new InMemoryBrakeFlag()
  const audit = new InMemoryAuditLog()
  const common = { brake, audit, clock: new FakeClock(), logger: new MemoryLogger() }
  const deps = {
    terminal,
    messages: en,
    engage: new EngageBrake(common),
    resume: new ResumeSession(common),
  }
  return { terminal, brake, audit, deps }
}

test('stop engages the brake as the terminal, then reports it is already engaged', () => {
  const { terminal, brake, audit, deps } = setup()
  expect(runStop(deps, 'lunch')).toBe(0)
  expect(brake.record).toMatchObject({ actor: 'terminal', reason: 'lunch' })
  expect(runStop(deps, undefined)).toBe(0)
  expect(terminal.out).toEqual([
    en.cliStopEngaged,
    en.cliStopAlreadyEngaged(new Date(brake.record?.engagedAt ?? 0).toISOString()),
  ])
  expect(audit.entries.map((e) => [e.actor, e.event])).toEqual([['terminal', 'brake.engaged']])
})

test('resume releases it as the terminal, idempotently', () => {
  const { terminal, brake, audit, deps } = setup()
  runStop(deps, undefined)
  expect(runResume(deps)).toBe(0)
  expect(runResume(deps)).toBe(0)
  expect(brake.status()).toEqual({ engaged: false })
  expect(terminal.out.slice(1)).toEqual([en.cliResumeReleased, en.cliResumeNotEngaged])
  expect(audit.entries.at(-1)).toMatchObject({ actor: 'terminal', event: 'brake.released' })
})
