import { describe, expect, test } from 'bun:test'
import {
  MAX_LAST_MESSAGE_LENGTH,
  projectHookPayload,
} from '../../../src/adapters/ipc/hookPayload.ts'
import { parseHookEvent } from '../../../src/application/hooks/hookEvents.ts'
import { createSecretRedactor } from '../../../src/domain/redaction/secretValues.ts'

const LITERAL = 'Zq8!vR2#pL9mW4xT7nB3'
const TOKEN = `ghp_${'K'.repeat(36)}`

/** What the notice is built from: hook projection, then channel parsing, then redaction. */
function throughTheBridge(event: 'Stop' | 'Notification', text: string): string {
  const raw =
    event === 'Stop'
      ? { hook_event_name: 'Stop', last_assistant_message: text }
      : { hook_event_name: 'Notification', message: text, notification_type: 'idle_prompt' }
  const parsed = parseHookEvent(JSON.parse(JSON.stringify(projectHookPayload(event, raw))))
  if (!parsed.ok) throw new Error(`rejected: ${parsed.fields.join(',')}`)
  const shown = parsed.event.name === 'Stop' ? parsed.event.lastAssistantMessage : undefined
  const message = parsed.event.name === 'Notification' ? parsed.event.message : shown
  return createSecretRedactor([LITERAL]).redact(message ?? '').text
}

function expectNoSecretFragment(text: string): void {
  expect(text).not.toContain('ghp_')
  expect(text).not.toContain('KKKK')
  for (let i = 0; i + 4 <= LITERAL.length; i++) expect(text).not.toContain(LITERAL.slice(i, i + 4))
}

describe('M3: the hook cuts only at the end, and the channel drops the cut line', () => {
  test('a message within the limit is forwarded whole, never elided in the middle', () => {
    const text = `START ${'x'.repeat(MAX_LAST_MESSAGE_LENGTH - 20)} END`
    expect(projectHookPayload('Stop', { last_assistant_message: text })).toEqual({
      hook_event_name: 'Stop',
      last_assistant_message: text,
    })
  })

  test('a longer one keeps its head and says it was cut', () => {
    const text = `${'a'.repeat(MAX_LAST_MESSAGE_LENGTH)}TAIL`
    expect(projectHookPayload('Stop', { last_assistant_message: text })).toEqual({
      hook_event_name: 'Stop',
      last_assistant_message: 'a'.repeat(MAX_LAST_MESSAGE_LENGTH),
      last_assistant_message_truncated: true,
    })
  })

  test('the channel drops the partial last line of a cut text and marks the cut', () => {
    const parsed = parseHookEvent({
      hook_event_name: 'Stop',
      last_assistant_message: 'line one\nline two\nhalf of a ghp_KKK',
      last_assistant_message_truncated: true,
    })
    expect(parsed).toMatchObject({
      ok: true,
      event: { lastAssistantMessage: 'line one\nline two\n…' },
    })
  })

  test.each(['Stop', 'Notification'] as const)(
    '%s: a secret straddling the cut point never shows a fragment',
    (event) => {
      const limit = event === 'Stop' ? MAX_LAST_MESSAGE_LENGTH : 4096
      for (let back = 1; back <= 60; back++) {
        for (const secret of [TOKEN, LITERAL]) {
          const head = `${'word '.repeat(Math.ceil(limit / 5))}`.slice(0, limit - back)
          const text = `intro\n${head.slice(6)} ${secret} and more\nlast line`
          const shown = throughTheBridge(event, text)
          expectNoSecretFragment(shown)
          expect(shown.startsWith('intro')).toBe(true)
        }
      }
    },
  )
})
