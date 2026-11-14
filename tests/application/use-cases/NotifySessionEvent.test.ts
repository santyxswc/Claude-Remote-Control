import { expect, test } from 'bun:test'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { NotifySessionEvent } from '../../../src/application/use-cases/NotifySessionEvent.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { NoticePolicy } from '../../../src/domain/notices/NoticePolicy.ts'
import {
  ALICE,
  BOB,
  FakeChatGateway,
  FakeClock,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  MemoryLogger,
} from '../../fakes.ts'

const en = messagesFor('en')

function harness(senders = [ALICE]) {
  const clock = new FakeClock()
  const chat = new FakeChatGateway()
  const allowed = new InMemoryAllowedSenders()
  for (const sender of senders) allowed.add(allowSender(sender, clock.now()))
  const audit = new InMemoryAuditLog()
  const logger = new MemoryLogger()
  const policy = new NoticePolicy()
  let relayedAt: number | undefined
  const notify = new NotifySessionEvent({
    chat,
    allowed,
    policy,
    lastPermissionRelayAt: () => relayedAt,
    messages: en,
    audit,
    clock,
    logger,
  })
  return {
    clock,
    chat,
    allowed,
    audit,
    logger,
    policy,
    notify,
    setRelayedAt: (at: number | undefined) => {
      relayedAt = at
    },
  }
}

const stop = (lastMessage: string | undefined, cwd = '/home/me/my-app') =>
  ({ event: 'Stop', cwd, lastMessage }) as const
const notification = (notificationType: string | undefined, message = 'Claude needs you') =>
  ({ event: 'Notification', cwd: '/home/me/my-app', message, notificationType }) as const

test('Stop: a "finished" notice with the project and the last message, to every sender', async () => {
  const h = harness([ALICE, BOB])
  expect(await h.notify.execute(stop('Refactored the parser.'))).toEqual({
    status: 'sent',
    delivered: 2,
  })
  expect(h.chat.sent.map((s) => s.chatId)).toEqual([ALICE.id, BOB.id])
  expect(h.chat.sent[0]?.text).toBe('✅ Claude finished in my-app.\n\nRefactored the parser.')
})

test('the audit row has the event and the length, never the text', async () => {
  const h = harness()
  await h.notify.execute(stop('secret plan details'))
  const entry = h.audit.entries.at(-1)
  expect(entry).toMatchObject({
    actor: 'session',
    event: 'notice.sent',
    details: { event: 'Stop', kind: 'finished', recipients: 1, delivered: 1 },
  })
  expect(entry?.details).toMatchObject({ length: h.chat.sent[0]?.text.length })
  expect(JSON.stringify(h.audit.entries)).not.toContain('secret plan')
  expect(h.logger.text).not.toContain('secret plan')
})

test('M3: a long last message goes out whole; the redacting gateway fits it to one message', async () => {
  const h = harness()
  const long = `START ${'x'.repeat(20_000)} END`
  await h.notify.execute(stop(long))
  expect(h.chat.sent[0]?.text).toContain(long)
  expect(h.chat.sent[0]?.options).toEqual({ fitToOneMessage: true })
})

test('no last message: just the headline', async () => {
  const h = harness()
  await h.notify.execute(stop(undefined, 'C:\\work\\api'))
  expect(h.chat.sent[0]?.text).toBe('✅ Claude finished in api.')
})

test('no notice when Claude already replied during the turn', async () => {
  const h = harness()
  h.policy.replied(h.clock.now())
  h.clock.advance(10_000)
  expect(await h.notify.execute(stop('done'))).toEqual({
    status: 'suppressed',
    reason: 'replied_this_turn',
  })
  expect(h.chat.sent).toEqual([])
  expect(h.audit.entries).toEqual([])
})

test('Notification: "needs your answer" for attention types; other types are ignored', async () => {
  const h = harness()
  expect(await h.notify.execute(notification('idle_prompt', 'Waiting for input'))).toMatchObject({
    status: 'sent',
  })
  expect(h.chat.sent[0]?.text).toBe('🔔 Claude needs your answer in my-app.\n\nWaiting for input')
  expect(await h.notify.execute(notification('auth_success'))).toEqual({ status: 'ignored' })
  expect(h.chat.sent).toHaveLength(1)
})

test('permission_prompt: skipped when F3 relayed it moments ago, sent otherwise', async () => {
  const h = harness()
  h.setRelayedAt(h.clock.now())
  h.clock.advance(6_000)
  expect(await h.notify.execute(notification('permission_prompt', 'Approve Bash?'))).toEqual({
    status: 'suppressed',
    reason: 'permission_already_relayed',
  })
  h.setRelayedAt(undefined)
  expect(await h.notify.execute(notification('permission_prompt', 'Approve Bash?'))).toMatchObject({
    status: 'sent',
  })
})

test('notices are off when nobody is paired', async () => {
  const h = harness([])
  expect(await h.notify.execute(stop('done'))).toEqual({ status: 'no_recipients' })
  expect(h.chat.sent).toEqual([])
  expect(h.audit.entries).toEqual([])
})

test('a failed delivery is counted, not thrown', async () => {
  const h = harness()
  h.chat.failWith = new Error('telegram down')
  expect(await h.notify.execute(stop('done'))).toEqual({ status: 'sent', delivered: 0 })
  expect(h.audit.entries.at(-1)?.details).toMatchObject({ delivered: 0, recipients: 1 })
})
