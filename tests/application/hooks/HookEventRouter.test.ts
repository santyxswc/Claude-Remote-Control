import { expect, test } from 'bun:test'
import { HookEventRouter, inputFragment } from '../../../src/application/hooks/HookEventRouter.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import type { LocalResolution } from '../../../src/application/use-cases/MarkPermissionResolvedLocally.ts'
import { NotifySessionEvent } from '../../../src/application/use-cases/NotifySessionEvent.ts'
import { TrackSessionActivity } from '../../../src/application/use-cases/TrackSessionActivity.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { NoticePolicy } from '../../../src/domain/notices/NoticePolicy.ts'
import {
  ALICE,
  FakeChatGateway,
  FakeClock,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  MemoryLogger,
} from '../../fakes.ts'

function harness() {
  const clock = new FakeClock()
  const chat = new FakeChatGateway()
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, clock.now()))
  const logger = new MemoryLogger()
  const policy = new NoticePolicy()
  const activity = new TrackSessionActivity(clock)
  const resolutions: LocalResolution[] = []
  const router = new HookEventRouter({
    notify: new NotifySessionEvent({
      chat,
      allowed,
      policy,
      lastPermissionRelayAt: () => undefined,
      messages: messagesFor('en'),
      audit: new InMemoryAuditLog(),
      clock,
      logger,
    }),
    activity,
    policy,
    markResolvedLocally: async (resolution) => {
      resolutions.push(resolution)
      return true
    },
    clock,
    logger,
  })
  return { clock, chat, logger, activity, resolutions, router }
}

test('a whole turn: prompt -> busy, tool -> buttons cleanup, Stop -> idle and a notice', async () => {
  const h = harness()
  await h.router.handle({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' })
  expect(h.activity.current()).toBe('busy')

  await h.router.handle({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'run tests' },
  })
  expect(h.resolutions).toEqual([{ toolName: 'Bash', inputFragment: 'npm test' }])

  h.clock.advance(60_000)
  await h.router.handle({
    hook_event_name: 'Stop',
    cwd: '/repo/app',
    last_assistant_message: 'Tests pass.',
  })
  expect(h.activity.current()).toBe('idle')
  expect(h.chat.sent.map((s) => s.text)).toEqual(['✅ Claude finished in app.\n\nTests pass.'])
})

test('a terminal prompt counts as the owner writing: an instant Stop sends nothing', async () => {
  const h = harness()
  await h.router.handle({ hook_event_name: 'UserPromptSubmit' })
  h.clock.advance(1_000)
  await h.router.handle({ hook_event_name: 'Stop', last_assistant_message: 'Hi!' })
  expect(h.chat.sent).toEqual([])
})

test('PostToolUse without tool_input matches by tool name only', async () => {
  const h = harness()
  await h.router.handle({ hook_event_name: 'PostToolUse', tool_name: 'WebSearch' })
  expect(h.resolutions).toEqual([{ toolName: 'WebSearch' }])
})

test('a malformed event is logged by field and ignored', async () => {
  const h = harness()
  await h.router.handle({ hook_event_name: 'PostToolUse', tool_name: '' })
  await h.router.handle({ nothing: true })
  expect(h.resolutions).toEqual([])
  expect(h.logger.text).toContain('ignored a malformed hook event')
})

test('more than one session id is reported once per new session', async () => {
  const h = harness()
  await h.router.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'a' })
  await h.router.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'a' })
  expect(h.logger.text).not.toContain('more than one')
  await h.router.handle({ hook_event_name: 'UserPromptSubmit', session_id: 'b' })
  expect(h.logger.entries.filter((e) => e.message.includes('more than one'))).toHaveLength(1)
})

test('the input fragment is JSON-escaped like the relayed preview', () => {
  expect(inputFragment({ command: 'echo "hi"' })).toBe('echo \\"hi\\"')
  expect(inputFragment({ file_path: 'C:\\repo\\a.ts', content: 'x' })).toBe('C:\\\\repo\\\\a.ts')
  expect(inputFragment({ command: 'x'.repeat(500) })).toHaveLength(120)
  expect(inputFragment({ content: 'only content' })).toBeUndefined()
  expect(inputFragment(undefined)).toBeUndefined()
  // The fragment is found in a preview Claude Code would build from the same input.
  const input = { file_path: 'C:\\repo\\a.ts', content: 'hello' }
  expect(JSON.stringify(input)).toContain(inputFragment(input) ?? 'missing')
})
