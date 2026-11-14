import { expect, test } from 'bun:test'
import { TrackSessionActivity } from '../../../src/application/use-cases/TrackSessionActivity.ts'
import { ACTIVITY_STALE_MS } from '../../../src/domain/session/ActivityLog.ts'
import { FakeClock } from '../../fakes.ts'

test('UserPromptSubmit -> busy, Stop -> idle', () => {
  const activity = new TrackSessionActivity(new FakeClock())
  expect(activity.current()).toBe('unknown')
  activity.turnStarted()
  expect(activity.current()).toBe('busy')
  activity.turnEnded()
  expect(activity.current()).toBe('idle')
})

test('a forwarded chat message starts a turn only once hooks are known to work', () => {
  const activity = new TrackSessionActivity(new FakeClock())
  activity.messageForwarded()
  expect(activity.current()).toBe('unknown') // no hooks: nothing would ever end the turn
  activity.turnEnded()
  activity.messageForwarded()
  expect(activity.current()).toBe('busy')
})

test('tool runs keep a long turn busy; silence makes it unknown', () => {
  const clock = new FakeClock()
  const activity = new TrackSessionActivity(clock)
  activity.turnStarted()
  clock.advance(ACTIVITY_STALE_MS)
  activity.toolRan()
  clock.advance(ACTIVITY_STALE_MS)
  expect(activity.current()).toBe('busy')
  clock.advance(1)
  expect(activity.current()).toBe('unknown')
})
