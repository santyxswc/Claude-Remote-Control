import { expect, test } from 'bun:test'
import { UnknownSessionActivity } from '../../../src/adapters/session/UnknownSessionActivity.ts'

test('never claims to know whether Claude is busy', () => {
  expect(new UnknownSessionActivity().current()).toBe('unknown')
})
