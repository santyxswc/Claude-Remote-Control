import { describe, expect, test } from 'bun:test'
import type { PermissionAction } from '../../../src/application/permissions/callbackData.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { CONFIRMATION_WINDOW_MS } from '../../../src/domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../../../src/domain/Sender.ts'
import { ALICE, BOB, MALLORY } from '../../fakes.ts'
import { en, incoming, permissionHarness } from '../permissionHarness.ts'

const HIGH = '{"command":"git push --force"}'

async function setup(inputPreview = '{"command":"ls"}') {
  const h = permissionHarness()
  h.allowed.add(allowSender(BOB, h.clock.now()))
  await h.relay.execute(incoming({ inputPreview }))
  const tap = (
    action: PermissionAction,
    sender: SenderProfile = ALICE,
    via: 'button' | 'text' = 'button',
  ) => h.resolve.execute({ requestId: 'abcde', action, sender, via })
  return { ...h, tap }
}

describe('low risk', () => {
  test('approve sends allow once, closes the request and updates every copy', async () => {
    const h = await setup()
    h.clock.advance(1234)

    expect(await h.tap('approve')).toBe('approved')

    expect(h.verdicts.sent).toEqual([{ requestId: 'abcde', behavior: 'allow' }])
    const stored = h.store.findById('abcde')
    expect(stored?.state).toBe('approved')
    expect(stored?.decidedBy).toBe(ALICE.id)
    expect(h.gateway.edits.map((e) => e.ref.chatId)).toEqual([ALICE.id, BOB.id])
    for (const edit of h.gateway.edits) {
      expect(edit.keyboard).toEqual([])
      expect(edit.text).toContain(
        en.permissionApproved({ who: '@alice', at: new Date(h.clock.now()).toISOString() }),
      )
    }
    expect(h.audit.entries.at(-1)).toMatchObject({
      actor: `telegram:${ALICE.id}`,
      event: 'permission.approved',
      details: { requestId: 'abcde', toolName: 'Bash', risk: 'low', via: 'button' },
    })
  })

  test('deny sends deny', async () => {
    const h = await setup()
    expect(await h.tap('deny', BOB)).toBe('denied')
    expect(h.verdicts.sent).toEqual([{ requestId: 'abcde', behavior: 'deny' }])
    expect(h.gateway.edits[0]?.text).toContain('❌ Denied by Bob B')
    expect(h.audit.events.at(-1)).toBe('permission.denied')
  })

  test('a second tap changes nothing and sends nothing', async () => {
    const h = await setup()
    await h.tap('approve')
    const edits = h.gateway.edits.length
    expect(await h.tap('approve')).toBe('already_resolved')
    expect(await h.tap('deny', BOB)).toBe('already_resolved')
    expect(h.verdicts.sent).toHaveLength(1)
    expect(h.gateway.edits).toHaveLength(edits)
  })

  test('text approval works for low risk', async () => {
    const h = await setup()
    expect(await h.tap('approve', ALICE, 'text')).toBe('approved')
    expect(h.audit.entries.at(-1)?.details).toMatchObject({ via: 'text' })
  })
})

describe('high risk', () => {
  test('approve asks for confirmation; confirm sends allow', async () => {
    const h = await setup(HIGH)
    expect(await h.tap('approve')).toBe('confirmation_requested')
    expect(h.verdicts.sent).toEqual([])
    expect(h.gateway.edits[0]?.keyboard).toEqual([
      [
        { label: en.permissionButtons.confirm, data: 'p1:abcde:c' },
        { label: en.permissionButtons.cancel, data: 'p1:abcde:x' },
      ],
    ])
    expect(h.audit.events.at(-1)).toBe('permission.confirmation_requested')

    h.clock.advance(CONFIRMATION_WINDOW_MS - 1)
    expect(await h.tap('confirm')).toBe('approved')
    expect(h.verdicts.sent).toEqual([{ requestId: 'abcde', behavior: 'allow' }])
    expect(h.gateway.edits.at(-1)?.keyboard).toEqual([])
  })

  test('cancel goes back to Approve / Deny without a verdict', async () => {
    const h = await setup(HIGH)
    await h.tap('approve')
    expect(await h.tap('cancel')).toBe('confirmation_cancelled')
    expect(h.store.findById('abcde')?.state).toBe('pending')
    expect(h.gateway.edits.at(-1)?.keyboard[0]?.map((b) => b.data)).toEqual([
      'p1:abcde:a',
      'p1:abcde:d',
    ])
    expect(h.verdicts.sent).toEqual([])
  })

  test('confirm after the window sends nothing and restores Approve / Deny', async () => {
    const h = await setup(HIGH)
    await h.tap('approve')
    h.clock.advance(CONFIRMATION_WINDOW_MS)
    expect(await h.tap('confirm')).toBe('confirmation_expired')
    expect(h.verdicts.sent).toEqual([])
    expect(h.store.findById('abcde')?.state).toBe('pending')
    expect(h.gateway.edits.at(-1)?.keyboard[0]?.[0]?.data).toBe('p1:abcde:a')
  })

  test('confirm without a prior approve is invalid', async () => {
    const h = await setup(HIGH)
    expect(await h.tap('confirm')).toBe('invalid')
    expect(h.verdicts.sent).toEqual([])
  })

  test('cannot be approved by text in one step; can be denied by text', async () => {
    const h = await setup(HIGH)
    expect(await h.tap('approve', ALICE, 'text')).toBe('use_button')
    expect(h.store.findById('abcde')?.state).toBe('pending')
    expect(await h.tap('deny', ALICE, 'text')).toBe('denied')
    expect(h.verdicts.sent).toEqual([{ requestId: 'abcde', behavior: 'deny' }])
  })
})

describe('refusals', () => {
  test('a sender who is not allowlisted (or was revoked) gets nothing', async () => {
    const h = await setup()
    expect(await h.tap('approve', MALLORY)).toBe('not_allowed')
    h.allowed.remove(BOB.id)
    expect(await h.tap('approve', BOB)).toBe('not_allowed')
    expect(h.verdicts.sent).toEqual([])
    expect(h.store.findById('abcde')?.state).toBe('pending')
  })

  test('unknown ids and other sessions are not found', async () => {
    const h = await setup()
    expect(
      await h.resolve.execute({
        requestId: 'zzzzz',
        action: 'approve',
        sender: ALICE,
        via: 'button',
      }),
    ).toBe('not_found')
  })

  test('an expired request says so', async () => {
    const h = await setup()
    const stored = h.store.findById('abcde')
    if (stored === undefined) throw new Error('missing')
    h.store.update(stored.expire(h.clock.now()), stored.revision)
    expect(await h.tap('approve')).toBe('expired')
    expect(h.verdicts.sent).toEqual([])
  })
})

test('when the verdict cannot be sent, the request is pending again and the buttons stay', async () => {
  const h = await setup()
  h.verdicts.failWith = new Error('Not connected')
  expect(await h.tap('approve')).toBe('delivery_failed')
  expect(h.store.findById('abcde')?.state).toBe('pending')
  expect(h.audit.events.at(-1)).toBe('permission.verdict_failed')
  expect(h.audit.events).not.toContain('permission.approved')
  expect(h.gateway.edits.at(-1)?.keyboard[0]?.[0]?.data).toBe('p1:abcde:a')

  h.verdicts.failWith = undefined
  expect(await h.tap('approve')).toBe('approved')
  expect(h.verdicts.sent).toEqual([{ requestId: 'abcde', behavior: 'allow' }])
})

test('losing a race to another writer sends nothing', async () => {
  const h = await setup()
  const stored = h.store.findById('abcde')
  if (stored === undefined) throw new Error('missing')
  // Another writer bumps the revision between our read and our write.
  const realUpdate = h.store.update.bind(h.store)
  let raced = false
  h.store.update = (next, expected) => {
    if (!raced) {
      raced = true
      const latest = h.store.findById('abcde')
      if (latest !== undefined) realUpdate(latest.deny(BOB.id, 1), latest.revision)
    }
    return realUpdate(next, expected)
  }
  expect(await h.tap('approve')).toBe('already_resolved')
  expect(h.verdicts.sent).toEqual([])
  expect(h.store.findById('abcde')?.state).toBe('denied')
})
