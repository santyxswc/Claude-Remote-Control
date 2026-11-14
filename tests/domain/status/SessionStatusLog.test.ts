/** The session state the pinned status shows, fed by hook signals (F9). */
import { describe, expect, test } from 'bun:test'
import { SessionStatusLog } from '../../../src/domain/status/SessionStatusLog.ts'

const bash = { tool: 'Bash', detail: 'Run the tests' }

describe('SessionStatusLog', () => {
  test('unknown until a hook says something', () => {
    const log = new SessionStatusLog()
    expect(log.snapshot()).toEqual({
      phase: 'unknown',
      since: undefined,
      activity: undefined,
      lastFinishedAt: undefined,
    })
    // A chat message alone proves nothing: hooks may not be installed.
    log.record({ kind: 'chat_message' }, 10)
    expect(log.snapshot().phase).toBe('unknown')
  })

  test('a turn: working since it began, last tool, then idle with the finish time', () => {
    const log = new SessionStatusLog()
    log.record({ kind: 'turn_started' }, 100)
    log.record({ kind: 'tool_ran', activity: bash }, 200)
    expect(log.snapshot()).toEqual({
      phase: 'working',
      since: 100,
      activity: bash,
      lastFinishedAt: undefined,
    })
    log.record({ kind: 'turn_ended' }, 300)
    expect(log.snapshot()).toEqual({
      phase: 'idle',
      since: 300,
      activity: undefined,
      lastFinishedAt: 300,
    })
  })

  test('waiting for the owner, then back to working since the turn began', () => {
    const log = new SessionStatusLog()
    log.record({ kind: 'turn_started' }, 100)
    log.record({ kind: 'attention' }, 150)
    expect(log.snapshot()).toMatchObject({ phase: 'waiting', since: 150 })
    log.record({ kind: 'tool_ran', activity: bash }, 400)
    expect(log.snapshot()).toMatchObject({ phase: 'working', since: 100 })
  })

  test('once hooks are seen, a chat message starts work', () => {
    const log = new SessionStatusLog()
    log.record({ kind: 'turn_ended' }, 50)
    log.record({ kind: 'chat_message' }, 60)
    expect(log.snapshot()).toMatchObject({ phase: 'working', since: 60, lastFinishedAt: 50 })
  })

  test('ended stays ended until a restart, which forgets the phase', () => {
    const log = new SessionStatusLog()
    log.record({ kind: 'tool_ran', activity: bash }, 10)
    log.record({ kind: 'ended' }, 20)
    expect(log.snapshot()).toMatchObject({ phase: 'ended', since: 20, activity: undefined })
    log.record({ kind: 'chat_message' }, 30)
    expect(log.snapshot().phase).toBe('ended')
    log.record({ kind: 'restarted' }, 40)
    expect(log.snapshot()).toMatchObject({ phase: 'unknown', since: undefined })
    // A restart while running changes nothing.
    log.record({ kind: 'turn_started' }, 50)
    log.record({ kind: 'restarted' }, 60)
    expect(log.snapshot()).toMatchObject({ phase: 'working', since: 50 })
  })
})
