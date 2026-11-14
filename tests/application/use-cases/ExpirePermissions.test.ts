import { expect, test } from 'bun:test'
import {
  CONFIRMATION_WINDOW_MS,
  PERMISSION_TTL_MS,
  PermissionRequest,
} from '../../../src/domain/permissions/PermissionRequest.ts'
import { ALICE } from '../../fakes.ts'
import { en, incoming, permissionHarness } from '../permissionHarness.ts'

test('requests past the TTL expire without a verdict; buttons removed and annotated', async () => {
  const h = permissionHarness()
  await h.relay.execute(incoming())
  h.clock.advance(PERMISSION_TTL_MS - 1)
  expect(await h.expire.execute()).toBe(0)
  expect(h.gateway.edits).toEqual([])

  h.clock.advance(1)
  expect(await h.expire.execute()).toBe(1)
  expect(h.store.findById('abcde')?.state).toBe('expired')
  expect(h.verdicts.sent).toEqual([])
  expect(h.gateway.edits[0]?.keyboard).toEqual([])
  expect(h.gateway.edits[0]?.text).toContain(en.permissionExpired)
  expect(h.audit.entries.at(-1)).toMatchObject({
    actor: 'system',
    event: 'permission.expired',
    details: { requestId: 'abcde', toolName: 'Bash', reason: 'ttl' },
  })
  expect(await h.expire.execute()).toBe(0)
})

test('a confirmation whose window passed shows Approve / Deny again', async () => {
  const h = permissionHarness()
  await h.relay.execute(incoming({ inputPreview: '{"command":"sudo ls"}' }))
  await h.resolve.execute({ requestId: 'abcde', action: 'approve', sender: ALICE, via: 'button' })
  h.clock.advance(CONFIRMATION_WINDOW_MS)
  await h.expire.execute()
  expect(h.store.findById('abcde')?.state).toBe('pending')
  expect(h.gateway.edits.at(-1)?.keyboard[0]?.[0]?.data).toBe('p1:abcde:a')
})

test('orphans of other sessions expire at once; our own are left alone', async () => {
  const h = permissionHarness()
  await h.relay.execute(incoming())
  h.store.put(
    PermissionRequest.open({
      id: 'zzzzz',
      session: 'previous-process',
      toolName: 'Write',
      description: '',
      inputPreview: '',
      risk: 'low',
      now: h.clock.now(),
    }).withPrompts([{ chatId: ALICE.id, messageId: '9' }]),
  )
  expect(await h.expire.execute()).toBe(0) // not ours, not due
  expect(await h.expire.expireOrphans()).toBe(1)
  expect(h.store.findById('zzzzz')?.state).toBe('expired')
  expect(h.store.findById('abcde')?.state).toBe('pending')
  expect(h.gateway.edits.map((e) => e.ref.messageId)).toEqual(['9'])
  expect(h.audit.entries.at(-1)?.details).toMatchObject({ reason: 'orphaned' })
  expect(h.verdicts.sent).toEqual([])
})
