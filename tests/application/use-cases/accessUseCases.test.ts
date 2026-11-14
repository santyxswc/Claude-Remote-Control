import { expect, test } from 'bun:test'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { ListAllowedSenders } from '../../../src/application/use-cases/ListAllowedSenders.ts'
import { RevokeSender } from '../../../src/application/use-cases/RevokeSender.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { ALICE, FakeClock, InMemoryAllowedSenders, InMemoryAuditLog, MALLORY } from '../../fakes.ts'

function setup() {
  const allowed = new InMemoryAllowedSenders()
  const audit = new InMemoryAuditLog()
  const clock = new FakeClock()
  allowed.add(allowSender(ALICE, 1))
  return {
    allowed,
    audit,
    clock,
    authorize: new AuthorizeSender(allowed),
    list: new ListAllowedSenders(allowed),
    revoke: new RevokeSender({ allowed, audit, clock }),
  }
}

test('AuthorizeSender allows only allowlisted sender ids', () => {
  const s = setup()
  expect(s.authorize.execute(ALICE.id)).toBe(true)
  expect(s.authorize.execute(MALLORY.id)).toBe(false)
  expect(s.authorize.execute('')).toBe(false)
  expect(s.authorize.execute('-100123')).toBe(false)
})

test('ListAllowedSenders lists them', () => {
  expect(setup().list.execute()).toEqual([{ ...ALICE, addedAt: 1 }])
})

test('RevokeSender removes and audits; an unknown id changes nothing', () => {
  const s = setup()
  expect(s.revoke.execute(MALLORY.id)).toBe(false)
  expect(s.audit.entries).toEqual([])

  expect(s.revoke.execute(ALICE.id)).toBe(true)
  expect(s.authorize.execute(ALICE.id)).toBe(false)
  expect(s.audit.entries).toEqual([
    {
      at: s.clock.now(),
      actor: 'terminal',
      event: 'sender.revoked',
      details: { senderId: ALICE.id },
    },
  ])
})
