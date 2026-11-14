import { expect, test } from 'bun:test'
import { en, incoming, permissionHarness } from '../permissionHarness.ts'

test('closes the oldest matching open request and removes its buttons', async () => {
  const h = permissionHarness()
  await h.relay.execute(incoming({ requestId: 'aaaaa', inputPreview: '{"command":"ls"}' }))
  h.clock.advance(10)
  await h.relay.execute(incoming({ requestId: 'bbbbb', inputPreview: '{"command":"pwd"}' }))

  expect(await h.markLocal.execute({ toolName: 'Bash' })).toBe(true)
  expect(h.store.findById('aaaaa')?.state).toBe('resolved_locally')
  expect(h.store.findById('bbbbb')?.state).toBe('pending')
  expect(h.gateway.edits[0]?.keyboard).toEqual([])
  expect(h.gateway.edits[0]?.text).toContain(en.permissionResolvedLocally)
  expect(h.audit.entries.at(-1)).toMatchObject({
    actor: 'terminal',
    event: 'permission.resolved_locally',
    details: { requestId: 'aaaaa', toolName: 'Bash' },
  })
  expect(h.verdicts.sent).toEqual([])
})

test('an input fragment narrows the match', async () => {
  const h = permissionHarness()
  await h.relay.execute(incoming({ requestId: 'aaaaa', inputPreview: '{"command":"ls"}' }))
  await h.relay.execute(incoming({ requestId: 'bbbbb', inputPreview: '{"command":"pwd"}' }))
  expect(await h.markLocal.execute({ toolName: 'Bash', inputFragment: 'pwd' })).toBe(true)
  expect(h.store.findById('bbbbb')?.state).toBe('resolved_locally')
  expect(h.store.findById('aaaaa')?.state).toBe('pending')
})

test('no match: nothing changes', async () => {
  const h = permissionHarness()
  await h.relay.execute(incoming())
  expect(await h.markLocal.execute({ toolName: 'Write' })).toBe(false)
  expect(await h.markLocal.execute({ toolName: 'Bash', inputFragment: 'rm' })).toBe(false)
  expect(h.store.findById('abcde')?.state).toBe('pending')
})
