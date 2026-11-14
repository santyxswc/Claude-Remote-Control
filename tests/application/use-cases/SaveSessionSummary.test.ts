import { describe, expect, test } from 'bun:test'
import { ProjectFileError } from '../../../src/application/errors.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { RedactingChatGateway } from '../../../src/application/outbound/RedactingChatGateway.ts'
import type {
  SavedSummary,
  SessionSummaryStore,
} from '../../../src/application/ports/SessionSummaryStore.ts'
import { AuthorizeReplyTarget } from '../../../src/application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import {
  MAX_SUMMARY_CHAT_LENGTH,
  SaveSessionSummary,
} from '../../../src/application/use-cases/SaveSessionSummary.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { createSecretRedactor } from '../../../src/domain/redaction/secretValues.ts'
import {
  ALICE,
  FakeChatGateway,
  FakeClock,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  MALLORY,
  MemoryLogger,
} from '../../fakes.ts'

const en = messagesFor('en')
const SECRET = 'Zq8vN3pL0xW7rT2yK5mB'

class FakeSummaryStore implements SessionSummaryStore {
  readonly saved: { name: string; content: string }[] = []
  readonly taken = new Set<string>()
  failWith: Error | undefined

  async save(name: (attempt: number) => string, content: string): Promise<SavedSummary> {
    if (this.failWith !== undefined) throw this.failWith
    let attempt = 0
    while (this.taken.has(name(attempt))) attempt += 1
    this.taken.add(name(attempt))
    this.saved.push({ name: name(attempt), content })
    return { relativePath: `docs/sessions/${name(attempt)}` }
  }
}

function harness() {
  const clock = new FakeClock(Date.UTC(2026, 10, 14, 10, 30, 5))
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, clock.now()))
  const store = new FakeSummaryStore()
  const chat = new FakeChatGateway()
  const audit = new InMemoryAuditLog()
  const save = new SaveSessionSummary({
    store,
    chat: new RedactingChatGateway(chat, createSecretRedactor([SECRET]), 4096),
    target: new AuthorizeReplyTarget(new AuthorizeSender(allowed)),
    render: (view) => en.summarySaved(view),
    audit,
    clock,
    logger: new MemoryLogger(),
  })
  return { store, chat, audit, save }
}

describe('SaveSessionSummary', () => {
  test('the bridge writes docs/sessions/<UTC stamp>-<slug>.md and sends it to the chat', async () => {
    const h = harness()
    const outcome = await h.save.execute({
      chatId: ALICE.id,
      title: 'Revisión de pagos',
      markdown: 'Hecho: todo.',
    })
    expect(outcome).toEqual({
      status: 'saved',
      path: 'docs/sessions/2026-11-14T103005Z-revision-de-pagos.md',
      notified: true,
    })
    expect(h.store.saved[0]?.content).toBe('# Revisión de pagos\n\nHecho: todo.\n')
    expect(h.chat.sent).toHaveLength(1)
    expect(h.chat.sent[0]?.text).toContain('docs/sessions/2026-11-14T103005Z-revision-de-pagos.md')
    expect(h.chat.sent[0]?.text).toContain('not redacted')
    expect(h.chat.sent[0]?.text).toContain('Hecho: todo.')
    expect(h.audit.entries).toMatchObject([
      { event: 'session.summary_saved', details: { notified: true } },
    ])
    expect(JSON.stringify(h.audit.entries)).not.toContain('Hecho')
  })

  test('never overwrites: the same title in the same second gets a suffix', async () => {
    const h = harness()
    await h.save.execute({ chatId: ALICE.id, title: 'x', markdown: 'a' })
    const second = await h.save.execute({ chatId: ALICE.id, title: 'x', markdown: 'b' })
    expect(second).toMatchObject({ path: 'docs/sessions/2026-11-14T103005Z-x-2.md' })
  })

  test('the chat copy goes through redaction; the file keeps what Claude wrote', async () => {
    const h = harness()
    await h.save.execute({ chatId: ALICE.id, title: 't', markdown: `token ${SECRET}` })
    expect(h.chat.sent[0]?.text).not.toContain(SECRET)
    expect(h.store.saved[0]?.content).toContain(SECRET)
  })

  test('a very long summary is saved but only its path is sent', async () => {
    const h = harness()
    const markdown = 'word '.repeat(MAX_SUMMARY_CHAT_LENGTH / 4)
    await h.save.execute({ chatId: ALICE.id, title: 't', markdown })
    expect(h.store.saved).toHaveLength(1)
    expect(h.chat.sent[0]?.text.length).toBeLessThan(500)
  })

  test('refusals', async () => {
    const h = harness()
    expect(await h.save.execute({ chatId: MALLORY.id, title: 't', markdown: 'a' })).toEqual({
      status: 'refused',
      reason: 'chat_not_allowed',
    })
    expect(await h.save.execute({ chatId: ALICE.id, title: ' ', markdown: 'a' })).toEqual({
      status: 'invalid',
      problem: 'empty_title',
    })
    h.store.failWith = new ProjectFileError('outside_project')
    expect(await h.save.execute({ chatId: ALICE.id, title: 't', markdown: 'a' })).toEqual({
      status: 'not_saved',
      problem: 'outside_project',
    })
    expect(h.store.saved).toEqual([])
    expect(h.chat.sent).toEqual([])
    expect(h.audit.events).toEqual([
      'session.summary_not_saved',
      'session.summary_not_saved',
      'session.summary_not_saved',
    ])
  })

  test('a failed chat notice still reports the saved path', async () => {
    const h = harness()
    h.chat.failWith = new Error('telegram down')
    expect(await h.save.execute({ chatId: ALICE.id, title: 't', markdown: 'a' })).toMatchObject({
      status: 'saved',
      notified: false,
    })
  })
})
