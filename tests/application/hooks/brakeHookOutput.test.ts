import { expect, test } from 'bun:test'
import { brakeHookOutput } from '../../../src/application/hooks/brakeHookOutput.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'

const en = messagesFor('en')
const FLAG = '/home/me/.claude/channels/telegram-bridge/brake.json'

test('engaged from Telegram: the exact bytes, one JSON object on one line', () => {
  const out = brakeHookOutput(
    {
      record: { engagedAt: Date.UTC(2026, 10, 14, 9, 30), actor: 'telegram:42', reason: 'oops' },
      flagPath: FLAG,
    },
    en,
  )
  expect(out).toBe(
    '{"continue":false,' +
      '"stopReason":"telegram-bridge: brake engaged from Telegram (2026-11-14T09:30:00.000Z). Claude stopped.\\n' +
      'Reason: oops\\n' +
      'To release it send /resume in Telegram or run \\"telegram-bridge resume\\".",' +
      '"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",' +
      '"permissionDecisionReason":"The telegram-bridge brake is engaged: the owner asked to stop. Do not retry; wait for the user."}}\n',
  )
  expect(out.trimEnd()).not.toContain('\n')
})

test('engaged from the terminal without a reason', () => {
  const out = JSON.parse(
    brakeHookOutput(
      { record: { engagedAt: 0, actor: 'terminal', reason: undefined }, flagPath: FLAG },
      en,
    ),
  )
  expect(out.stopReason).toBe(
    'telegram-bridge: brake engaged from the terminal (1970-01-01T00:00:00.000Z). Claude stopped.\n' +
      'To release it send /resume in Telegram or run "telegram-bridge resume".',
  )
})

test('an unreadable flag still stops, and names the file to delete', () => {
  const out = JSON.parse(brakeHookOutput({ record: undefined, flagPath: FLAG }, messagesFor('es')))
  expect(out.continue).toBe(false)
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  expect(out.stopReason).toContain(FLAG)
  expect(out.stopReason).toContain('telegram-bridge resume')
})
