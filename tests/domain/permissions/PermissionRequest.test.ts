import { describe, expect, test } from 'bun:test'
import {
  CONFIRMATION_WINDOW_MS,
  InvalidPermissionRequestIdError,
  InvalidPermissionTransitionError,
  isPermissionRequestId,
  PERMISSION_TTL_MS,
  PermissionRequest,
  type RiskLevel,
} from '../../../src/domain/permissions/PermissionRequest.ts'

const T0 = 1_700_000_000_000
const OWNER = '5000000001'

function open(risk: RiskLevel = 'low'): PermissionRequest {
  return PermissionRequest.open({
    id: 'abcde',
    session: 's1',
    toolName: 'Bash',
    description: 'List files',
    inputPreview: '{"command":"ls"}',
    risk,
    now: T0,
  })
}

const invalid = (action: () => unknown) => expect(action).toThrow(InvalidPermissionTransitionError)

describe('request ids', () => {
  test.each([['abcde'], ['zzzzz'], ['kmnop']])('%p is valid', (id) => {
    expect(isPermissionRequestId(id)).toBe(true)
  })

  test.each([['abcdl'], ['ABCDE'], ['abcd'], ['abcdef'], ['abc1e'], [' abcde'], ['']])(
    '%p is not',
    (id) => {
      expect(isPermissionRequestId(id)).toBe(false)
    },
  )

  test('open() refuses an invalid id', () => {
    expect(() =>
      PermissionRequest.open({
        id: 'hello',
        session: 's',
        toolName: 'Bash',
        description: '',
        inputPreview: '',
        risk: 'low',
        now: T0,
      }),
    ).toThrow(InvalidPermissionRequestIdError)
  })
})

describe('pending', () => {
  test('starts pending, open, without a decision', () => {
    const request = open()
    expect(request.state).toBe('pending')
    expect(request.isOpen).toBe(true)
    expect(request.decidedBy).toBeUndefined()
    expect(request.revision).toBe(0)
  })

  test('low risk: approve -> approved, recording who and when', () => {
    const approved = open().approve(OWNER, T0 + 5)
    expect(approved.state).toBe('approved')
    expect(approved.decidedBy).toBe(OWNER)
    expect(approved.decidedAt).toBe(T0 + 5)
    expect(approved.isOpen).toBe(false)
    expect(approved.revision).toBe(1)
  })

  test('high risk: approve -> awaiting_confirmation, nothing decided yet', () => {
    const awaiting = open('high').approve(OWNER, T0 + 5)
    expect(awaiting.state).toBe('awaiting_confirmation')
    expect(awaiting.confirmationRequestedAt).toBe(T0 + 5)
    expect(awaiting.decidedBy).toBeUndefined()
    expect(awaiting.isOpen).toBe(true)
  })

  test('deny -> denied', () => {
    const denied = open().deny(OWNER, T0 + 1)
    expect(denied.state).toBe('denied')
    expect(denied.decidedBy).toBe(OWNER)
  })

  test('expire -> expired; resolveLocally -> resolved_locally', () => {
    expect(open().expire(T0 + 1).state).toBe('expired')
    expect(open().resolveLocally(T0 + 1).state).toBe('resolved_locally')
  })

  test('confirm and cancel are invalid while pending', () => {
    invalid(() => open('high').confirm(OWNER, T0))
    invalid(() => open().cancel(T0))
    invalid(() => open().deliveryFailed())
  })

  test('isDue after the TTL only', () => {
    expect(open().isDue(T0 + PERMISSION_TTL_MS - 1)).toBe(false)
    expect(open().isDue(T0 + PERMISSION_TTL_MS)).toBe(true)
    expect(
      open()
        .deny(OWNER, T0)
        .isDue(T0 + PERMISSION_TTL_MS),
    ).toBe(false)
  })
})

describe('awaiting_confirmation', () => {
  const awaiting = () => open('high').approve(OWNER, T0)

  test('confirm within the window -> approved by the confirmer', () => {
    const approved = awaiting().confirm('5000000002', T0 + CONFIRMATION_WINDOW_MS - 1)
    expect(approved.state).toBe('approved')
    expect(approved.decidedBy).toBe('5000000002')
  })

  test('confirm after the window is invalid', () => {
    invalid(() => awaiting().confirm(OWNER, T0 + CONFIRMATION_WINDOW_MS))
  })

  test('cancel -> pending', () => {
    const pending = awaiting().cancel(T0 + 1)
    expect(pending.state).toBe('pending')
    expect(pending.confirmationRequestedAt).toBeUndefined()
  })

  test('deny, expire and resolveLocally still apply', () => {
    expect(awaiting().deny(OWNER, T0).state).toBe('denied')
    expect(awaiting().expire(T0).state).toBe('expired')
    expect(awaiting().resolveLocally(T0).state).toBe('resolved_locally')
  })

  test('a second approve is invalid', () => {
    invalid(() => awaiting().approve(OWNER, T0))
  })

  test('settle falls back to pending once the window passes, and not before', () => {
    const request = awaiting()
    expect(request.settle(T0 + CONFIRMATION_WINDOW_MS - 1)).toBe(request)
    const settled = request.settle(T0 + CONFIRMATION_WINDOW_MS)
    expect(settled.state).toBe('pending')
    expect(settled.revision).toBe(request.revision + 1)
  })
})

describe('closed states', () => {
  const closed = {
    approved: () => open().approve(OWNER, T0),
    denied: () => open().deny(OWNER, T0),
    expired: () => open().expire(T0),
    resolved_locally: () => open().resolveLocally(T0),
  }

  test.each(Object.entries(closed))('%s refuses every answer', (_name, make) => {
    const request = make()
    invalid(() => request.approve(OWNER, T0))
    invalid(() => request.confirm(OWNER, T0))
    invalid(() => request.deny(OWNER, T0))
    invalid(() => request.cancel(T0))
    invalid(() => request.expire(T0))
    invalid(() => request.resolveLocally(T0))
    expect(request.settle(T0 + PERMISSION_TTL_MS)).toBe(request)
  })

  test('approving twice is invalid', () => {
    invalid(() => open().approve(OWNER, T0).approve(OWNER, T0))
  })

  test('approving an expired request is invalid', () => {
    invalid(() => open().expire(T0).approve(OWNER, T0))
  })

  test('a failed delivery takes approved or denied back to pending', () => {
    for (const decided of [closed.approved(), closed.denied()]) {
      const back = decided.deliveryFailed()
      expect(back.state).toBe('pending')
      expect(back.decidedBy).toBeUndefined()
      expect(back.decidedAt).toBeUndefined()
    }
    invalid(() => closed.expired().deliveryFailed())
    invalid(() => closed.resolved_locally().deliveryFailed())
  })
})

test('withPrompts appends refs and bumps the revision without changing the state', () => {
  const request = open().withPrompts([{ chatId: '1', messageId: '2' }])
  const more = request.withPrompts([{ chatId: '3', messageId: '4' }])
  expect(more.prompts).toEqual([
    { chatId: '1', messageId: '2' },
    { chatId: '3', messageId: '4' },
  ])
  expect(more.state).toBe('pending')
  expect(more.revision).toBe(2)
})

test('snapshots round-trip', () => {
  const request = open('high').approve(OWNER, T0)
  expect(PermissionRequest.restore(request.toSnapshot()).toSnapshot()).toEqual(request.toSnapshot())
})
