import { expect, test } from 'bun:test'
import { parseHookEvent } from '../../../src/application/hooks/hookEvents.ts'

test('Stop with the documented fields, plus unknown ones', () => {
  const result = parseHookEvent({
    hook_event_name: 'Stop',
    session_id: 'abc',
    cwd: '/home/me/app',
    last_assistant_message: 'All done.',
    stop_hook_active: false,
    background_tasks: [],
    some_future_field: { x: 1 },
  })
  expect(result).toEqual({
    ok: true,
    event: {
      name: 'Stop',
      sessionId: 'abc',
      cwd: '/home/me/app',
      lastAssistantMessage: 'All done.',
    },
  })
})

test('missing optional fields are tolerated', () => {
  expect(parseHookEvent({ hook_event_name: 'Stop' })).toEqual({
    ok: true,
    event: { name: 'Stop', sessionId: undefined, cwd: undefined, lastAssistantMessage: undefined },
  })
  expect(parseHookEvent({ hook_event_name: 'UserPromptSubmit' })).toMatchObject({
    ok: true,
    event: { name: 'UserPromptSubmit' },
  })
})

test('Notification and PostToolUse', () => {
  expect(
    parseHookEvent({
      hook_event_name: 'Notification',
      message: 'Claude is waiting for your input',
      notification_type: 'idle_prompt',
    }),
  ).toMatchObject({
    ok: true,
    event: {
      name: 'Notification',
      message: 'Claude is waiting for your input',
      notificationType: 'idle_prompt',
    },
  })
  expect(
    parseHookEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    }),
  ).toMatchObject({
    ok: true,
    event: { name: 'PostToolUse', toolName: 'Bash', toolInput: { command: 'ls' } },
  })
})

test('malformed payloads report field paths only, never values', () => {
  const secret = 'ghp_notreallyasecretbutlookslikeone0000000'
  const result = parseHookEvent({ hook_event_name: 'PostToolUse', tool_name: 42, cwd: secret })
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(parseHookEvent({ hook_event_name: 'SessionStart' }).ok).toBe(false)
  expect(parseHookEvent('Stop').ok).toBe(false)
  expect(parseHookEvent(null).ok).toBe(false)
  expect(parseHookEvent({ hook_event_name: 'Stop', last_assistant_message: 7 }).ok).toBe(false)
})
