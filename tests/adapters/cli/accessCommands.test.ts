import { expect, test } from 'bun:test'
import {
  type AccessCommandDeps,
  runAccessList,
  runAccessRevoke,
} from '../../../src/adapters/cli/accessCommands.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { ListAllowedSenders } from '../../../src/application/use-cases/ListAllowedSenders.ts'
import { RevokeSender } from '../../../src/application/use-cases/RevokeSender.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import {
  ALICE,
  FakeClock,
  FakeTerminal,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  MALLORY,
} from '../../fakes.ts'

const es = messagesFor('es')

function setup() {
  const allowed = new InMemoryAllowedSenders()
  const terminal = new FakeTerminal()
  const deps: AccessCommandDeps = {
    terminal,
    messages: es,
    listAllowed: new ListAllowedSenders(allowed),
    revokeSender: new RevokeSender({
      allowed,
      audit: new InMemoryAuditLog(),
      clock: new FakeClock(),
    }),
  }
  return { allowed, terminal, deps }
}

test('access list with nobody allowed', () => {
  const s = setup()
  expect(runAccessList(s.deps)).toBe(0)
  expect(s.terminal.out).toEqual([es.accessListEmpty])
})

test('access list shows name, handle, exact id and date', () => {
  const s = setup()
  s.allowed.add(allowSender(MALLORY, Date.UTC(2026, 10, 13)))
  expect(runAccessList(s.deps)).toBe(0)
  expect(s.terminal.out).toEqual([
    es.accessListHeader,
    '  id 9007199254740993, "Mallory" (@mallory), agregada el 2026-11-13T00:00:00.000Z',
  ])
})

test('access revoke removes a sender', () => {
  const s = setup()
  s.allowed.add(allowSender(ALICE, 0))
  expect(runAccessRevoke(s.deps, ALICE.id)).toBe(0)
  expect(s.terminal.out).toEqual([es.accessRevoked(ALICE.id)])
  expect(s.allowed.has(ALICE.id)).toBe(false)
})

test('access revoke of an unknown id fails', () => {
  const s = setup()
  expect(runAccessRevoke(s.deps, '42')).toBe(1)
  expect(s.terminal.err).toEqual([es.accessNotFound('42')])
})

test('access revoke with a non-numeric id is a usage error', () => {
  const s = setup()
  expect(runAccessRevoke(s.deps, '@alice')).toBe(2)
  expect(s.terminal.err).toEqual([es.accessInvalidId])
})
