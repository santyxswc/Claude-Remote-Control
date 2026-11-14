import { describe, expect, test } from 'bun:test'
import {
  DUPLICATE_NOTICE_WINDOW_MS,
  type NoticeCandidate,
  NoticePolicy,
  OWNER_QUIET_MS,
  PERMISSION_NOTICE_COVER_MS,
} from '../../../src/domain/notices/NoticePolicy.ts'

const T0 = 1_700_000_000_000
const finished = (text = 'done'): NoticeCandidate => ({ kind: 'finished', text })
const attention = (
  trigger: 'idle' | 'permission' | 'other',
  text = 'waiting',
  permissionRelayedAt?: number,
): NoticeCandidate => ({ kind: 'attention', text, trigger, permissionRelayedAt })

describe('finished', () => {
  test('sent when Claude did not reply during the turn', () => {
    expect(new NoticePolicy().decide(finished(), T0)).toBeUndefined()
  })

  test('suppressed when Claude replied in the chat during the turn', () => {
    const policy = new NoticePolicy()
    policy.replied(T0)
    expect(policy.decide(finished(), T0 + 60_000)).toBe('replied_this_turn')
  })

  test('a reply of an earlier turn does not count', () => {
    const policy = new NoticePolicy()
    policy.replied(T0)
    policy.decide(finished('one'), T0 + 1_000)
    expect(policy.decide(finished('two'), T0 + 120_000)).toBeUndefined()
  })
})

describe('duplicates', () => {
  test('the same text within the window is dropped, after it is sent again', () => {
    const policy = new NoticePolicy()
    expect(policy.decide(finished('same'), T0)).toBeUndefined()
    expect(policy.decide(finished('same'), T0 + DUPLICATE_NOTICE_WINDOW_MS - 1)).toBe('duplicate')
    expect(policy.decide(finished('same'), T0 + 2 * DUPLICATE_NOTICE_WINDOW_MS)).toBeUndefined()
  })

  test('different texts are not duplicates', () => {
    const policy = new NoticePolicy()
    expect(policy.decide(attention('other', 'a'), T0)).toBeUndefined()
    expect(policy.decide(attention('other', 'b'), T0 + 1)).toBeUndefined()
  })
})

describe('owner just wrote', () => {
  test('no notice of any kind right after the owner wrote', () => {
    const policy = new NoticePolicy()
    policy.ownerWrote(T0)
    expect(policy.decide(finished(), T0 + OWNER_QUIET_MS - 1)).toBe('owner_just_wrote')
    expect(policy.decide(attention('other'), T0 + OWNER_QUIET_MS - 1)).toBe('owner_just_wrote')
    expect(policy.decide(attention('other'), T0 + OWNER_QUIET_MS)).toBeUndefined()
  })
})

describe('permission prompts', () => {
  test('dropped while F3 relayed the prompt moments ago', () => {
    const policy = new NoticePolicy()
    const now = T0 + 6_000
    expect(policy.decide(attention('permission', 'p', T0), now)).toBe('permission_already_relayed')
  })

  test('sent when nothing was relayed, or long ago', () => {
    const policy = new NoticePolicy()
    expect(policy.decide(attention('permission', 'p1'), T0)).toBeUndefined()
    expect(
      policy.decide(attention('permission', 'p2', T0), T0 + PERMISSION_NOTICE_COVER_MS),
    ).toBeUndefined()
  })
})

describe('idle reminder', () => {
  test('dropped when the end of the turn was already told', () => {
    const policy = new NoticePolicy()
    policy.decide(finished(), T0)
    expect(policy.decide(attention('idle'), T0 + 60_000)).toBe('turn_end_already_told')
  })

  test('dropped when Claude replied during the turn instead', () => {
    const policy = new NoticePolicy()
    policy.replied(T0)
    expect(policy.decide(finished(), T0 + 1_000)).toBe('replied_this_turn')
    expect(policy.decide(attention('idle'), T0 + 61_000)).toBe('turn_end_already_told')
  })

  test('sent when no turn end was told (no Stop seen, or an interrupted turn)', () => {
    const policy = new NoticePolicy()
    expect(policy.decide(attention('idle', 'i1'), T0)).toBeUndefined()
    policy.decide(finished(), T0 + 1_000)
    policy.ownerWrote(T0 + 2_000) // a new turn that is then interrupted: no Stop
    expect(policy.decide(attention('idle', 'i2'), T0 + 70_000)).toBeUndefined()
  })

  test('a finished notice dropped as a duplicate does not count as told', () => {
    const policy = new NoticePolicy()
    policy.decide(finished('x'), T0)
    policy.ownerWrote(T0 + 5_000)
    expect(policy.decide(finished('x'), T0 + 10_000)).toBe('duplicate')
    expect(policy.decide(attention('idle'), T0 + 70_000)).toBeUndefined()
  })
})
