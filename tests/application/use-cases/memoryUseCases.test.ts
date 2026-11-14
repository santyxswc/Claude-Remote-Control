import { describe, expect, test } from 'bun:test'
import { WrapCommand } from '../../../src/application/commands/WrapCommand.ts'
import { ProjectFileError, PromptRedactedError } from '../../../src/application/errors.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { MemoryPrompts } from '../../../src/application/memory/MemoryPrompts.ts'
import {
  encodeMemoryCallback,
  parseMemoryCallback,
} from '../../../src/application/memory/memoryCallbackData.ts'
import { RedactingPromptGateway } from '../../../src/application/outbound/RedactingPromptGateway.ts'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import type { MemoryProposalStore } from '../../../src/application/ports/MemoryProposalStore.ts'
import type {
  AppendedNotes,
  ProjectMemoryFile,
} from '../../../src/application/ports/ProjectMemoryFile.ts'
import { AuthorizeReplyTarget } from '../../../src/application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { ExpireMemoryProposals } from '../../../src/application/use-cases/ExpireMemoryProposals.ts'
import type { ForwardableMessage } from '../../../src/application/use-cases/HandleInboundMessage.ts'
import { ProposeMemory } from '../../../src/application/use-cases/ProposeMemory.ts'
import { RequestSessionWrap } from '../../../src/application/use-cases/RequestSessionWrap.ts'
import { ResolveMemoryProposal } from '../../../src/application/use-cases/ResolveMemoryProposal.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import {
  MEMORY_PROPOSAL_TTL_MS,
  MemoryProposal,
} from '../../../src/domain/memory/MemoryProposal.ts'
import { createSecretRedactor } from '../../../src/domain/redaction/secretValues.ts'
import {
  ALICE,
  FakeClock,
  FakePromptGateway,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  InMemoryBrakeFlag,
  MALLORY,
  MemoryLogger,
  SequentialRandom,
} from '../../fakes.ts'

const en = messagesFor('en')
const SECRET = 'Zq8vN3pL0xW7rT2yK5mB'
const LINES = ['Run bun run check before every commit', 'Fonts live in assets/fonts']

class InMemoryMemoryProposalStore implements MemoryProposalStore {
  readonly rows = new Map<string, MemoryProposal>()
  put(proposal: MemoryProposal): void {
    this.rows.set(proposal.id, proposal)
  }
  update(next: MemoryProposal, expectedRevision: number): boolean {
    if (this.rows.get(next.id)?.revision !== expectedRevision) return false
    this.rows.set(next.id, next)
    return true
  }
  findById(id: string): MemoryProposal | undefined {
    return this.rows.get(id)
  }
  listPending(): readonly MemoryProposal[] {
    return [...this.rows.values()].filter((p) => p.isPending)
  }
}

class FakeMemoryFile implements ProjectMemoryFile {
  readonly appended: (readonly string[])[] = []
  failWith: Error | undefined
  gate: Promise<void> | undefined
  async append(lines: readonly string[]): Promise<AppendedNotes> {
    await this.gate
    if (this.failWith !== undefined) throw this.failWith
    this.appended.push(lines)
    return { relativePath: 'CLAUDE.md', created: false }
  }
}

function harness(options: { maxLength?: number } = {}) {
  const clock = new FakeClock()
  const store = new InMemoryMemoryProposalStore()
  const gateway = new FakePromptGateway()
  const logger = new MemoryLogger()
  const audit = new InMemoryAuditLog()
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, clock.now()))
  const authorize = new AuthorizeSender(allowed)
  const brake = new InMemoryBrakeFlag()
  const redacting = new RedactingPromptGateway(
    gateway,
    createSecretRedactor([SECRET]),
    options.maxLength ?? 4096,
  )
  const prompts = new MemoryPrompts(redacting, en, logger)
  const file = new FakeMemoryFile()
  const forwarded: ForwardableMessage[] = []
  const forward = {
    execute: async (message: ForwardableMessage) => {
      forwarded.push(message)
      return 'forwarded' as const
    },
  }
  let polling = true
  const common = { store, prompts, audit, clock, logger, session: 'me' }
  const propose = new ProposeMemory({
    ...common,
    target: new AuthorizeReplyTarget(authorize),
    random: new SequentialRandom(),
    canAsk: () => polling,
  })
  const resolve = new ResolveMemoryProposal({
    ...common,
    file,
    forward,
    authorize,
    brake,
    messages: en,
  })
  const expire = new ExpireMemoryProposals(common)
  const tap = (proposalId: string, action: 'approve' | 'reject', overrides = {}) =>
    resolve.execute({
      proposalId,
      action,
      sender: ALICE,
      chatId: ALICE.id,
      messageId: '500',
      ...overrides,
    })
  async function proposed(lines = LINES): Promise<string> {
    const outcome = await propose.execute({ chatId: ALICE.id, lines })
    if (outcome.status !== 'proposed') throw new Error(`not proposed: ${outcome.status}`)
    return outcome.proposalId
  }
  return {
    clock,
    store,
    gateway,
    audit,
    brake,
    file,
    forwarded,
    propose,
    resolve,
    expire,
    tap,
    proposed,
    stopPolling: () => {
      polling = false
    },
  }
}

/** Audit rows carry ids, counts and reasons; never the proposed text. */
function expectNoLineText(audit: InMemoryAuditLog, lines: readonly string[] = LINES): void {
  const rows = JSON.stringify(audit.entries)
  for (const line of lines) expect(rows).not.toContain(line)
}

describe('memory callback data', () => {
  test('round trip, strict and anchored', () => {
    expect(encodeMemoryCallback('abcdefghij', 'approve')).toBe('m1:abcdefghij:a')
    expect(parseMemoryCallback('m1:abcdefghij:r')).toEqual({
      proposalId: 'abcdefghij',
      action: 'reject',
    })
    for (const bad of [
      'm1:abcdefghij:x',
      'm1:abcdefghi:a',
      'xm1:abcdefghij:a',
      'p1:abcde:a',
      'm1:ABCDEFGHIJ:a',
      undefined,
    ]) {
      expect(parseMemoryCallback(bad)).toBeUndefined()
    }
  })
})

describe('ProposeMemory', () => {
  test('shows every line with Approve and Reject, stores it pending, returns at once', async () => {
    const h = harness()
    const id = await h.proposed()
    expect(h.gateway.sent).toHaveLength(1)
    const [prompt] = h.gateway.sent
    for (const line of LINES) expect(prompt?.text).toContain(`- ${line}`)
    expect(prompt?.keyboard).toEqual([
      [
        { label: en.memoryButtons.approve, data: `m1:${id}:a` },
        { label: en.memoryButtons.reject, data: `m1:${id}:r` },
      ],
    ])
    expect(h.store.findById(id)).toMatchObject({ state: 'pending', prompt: { messageId: '500' } })
    expect(h.audit.events).toEqual(['memory.proposed'])
    expect(h.audit.entries[0]?.details).toMatchObject({ proposalId: id, lines: 2 })
    expect(h.file.appended).toEqual([])
    expectNoLineText(h.audit)
  })

  test('only the chat of a paired user, and only while polling', async () => {
    const h = harness()
    expect(await h.propose.execute({ chatId: MALLORY.id, lines: LINES })).toEqual({
      status: 'refused',
      reason: 'chat_not_allowed',
    })
    h.stopPolling()
    expect(await h.propose.execute({ chatId: ALICE.id, lines: LINES })).toEqual({
      status: 'refused',
      reason: 'not_polling',
    })
    expect(h.gateway.sent).toEqual([])
    expect(h.store.rows.size).toBe(0)
  })

  test('invalid lines are refused with the line number', async () => {
    const h = harness()
    expect(await h.propose.execute({ chatId: ALICE.id, lines: ['ok', 'two\nlines'] })).toEqual({
      status: 'invalid',
      problem: 'control_characters',
      line: 2,
    })
    expect(h.gateway.sent).toEqual([])
    expect(h.store.rows.size).toBe(0)
  })

  test('a line redaction would change is refused: the owner must see what is written', async () => {
    const h = harness()
    const lines = [`The deploy key is ${SECRET}`]
    expect(await h.propose.execute({ chatId: ALICE.id, lines })).toEqual({
      status: 'invalid',
      problem: 'contains_secret',
    })
    expect(h.gateway.sent).toEqual([])
    expect(h.store.listPending()).toEqual([])
    expect(h.audit.events).toEqual(['memory.refused'])
    expectNoLineText(h.audit, lines)
    expect(JSON.stringify(h.audit.entries)).not.toContain(SECRET)
  })

  test('lines that do not fit one message are refused, never cut', async () => {
    const h = harness({ maxLength: 300 })
    const lines = Array.from({ length: 8 }, (_, i) => `${i} ${'x'.repeat(200)}`)
    expect(await h.propose.execute({ chatId: ALICE.id, lines })).toEqual({
      status: 'invalid',
      problem: 'too_long_for_one_message',
    })
    expect(h.store.listPending()).toEqual([])
  })
})

describe('RedactingPromptGateway with redaction: refuse', () => {
  test('throws instead of sending redacted text or labels', async () => {
    const gateway = new FakePromptGateway()
    const redacting = new RedactingPromptGateway(gateway, createSecretRedactor([SECRET]), 4096)
    await expect(
      redacting.sendPrompt('1', `x ${SECRET}`, [], { redaction: 'refuse' }),
    ).rejects.toBeInstanceOf(PromptRedactedError)
    await expect(
      redacting.sendPrompt('1', 'x', [[{ label: SECRET, data: 'd' }]], { redaction: 'refuse' }),
    ).rejects.toBeInstanceOf(PromptRedactedError)
    expect(gateway.sent).toEqual([])
    // Without the option it still redacts as before.
    await redacting.sendPrompt('1', `x ${SECRET}`, [])
    expect(gateway.sent[0]?.text).not.toContain(SECRET)
  })
})

describe('ResolveMemoryProposal', () => {
  test('Approve: the bridge writes the lines once, tells the session, removes the buttons', async () => {
    const h = harness()
    const id = await h.proposed()
    expect(await h.tap(id, 'approve')).toBe('approved')
    expect(h.file.appended).toEqual([LINES])
    expect(h.store.findById(id)).toMatchObject({ state: 'approved', resolvedBy: ALICE.id })
    expect(h.audit.events).toEqual(['memory.proposed', 'memory.approved'])
    expect(h.audit.entries[1]?.details).toEqual({ proposalId: id, lines: 2 })
    expect(h.forwarded).toHaveLength(1)
    expect(h.forwarded[0]).toMatchObject({
      chatId: ALICE.id,
      forwardContext: { kind: 'memory', proposalId: id },
    })
    expect(h.forwarded[0]?.text).toBe(
      en.memorySessionOutcome({ outcome: 'approved', proposalId: id, lines: 2, file: 'CLAUDE.md' }),
    )
    const edit = h.gateway.edits.at(-1)
    expect(edit?.keyboard).toEqual([])
    expect(edit?.text).toContain(LINES[0] as string)
    expectNoLineText(h.audit)
  })

  test('taps are idempotent: a second tap only gets a toast', async () => {
    const h = harness()
    const id = await h.proposed()
    await h.tap(id, 'approve')
    expect(await h.tap(id, 'approve')).toBe('already_resolved')
    expect(await h.tap(id, 'reject')).toBe('already_resolved')
    expect(h.file.appended).toHaveLength(1)
    expect(h.forwarded).toHaveLength(1)
  })

  test('two taps at once write once', async () => {
    const h = harness()
    const id = await h.proposed()
    let open: () => void = () => {}
    h.file.gate = new Promise((resolve) => {
      open = resolve
    })
    const both = Promise.all([h.tap(id, 'approve'), h.tap(id, 'approve')])
    open()
    expect((await both).sort()).toEqual(['already_resolved', 'approved'])
    expect(h.file.appended).toHaveLength(1)
  })

  test('braked: the approval still writes, but nothing is sent to the session', async () => {
    const h = harness()
    const id = await h.proposed()
    h.brake.engage({ engagedAt: 0, by: 'cli', reason: undefined } as never)
    expect(await h.tap(id, 'approve')).toBe('approved_braked')
    expect(h.file.appended).toEqual([LINES])
    expect(h.forwarded).toEqual([])
  })

  test('a failed write leaves the proposal pending, so it can be approved again', async () => {
    const h = harness()
    const id = await h.proposed()
    h.file.failWith = new ProjectFileError('outside_project')
    expect(await h.tap(id, 'approve')).toBe('write_failed')
    expect(h.store.findById(id)?.state).toBe('pending')
    expect(h.audit.entries.at(-1)).toMatchObject({
      event: 'memory.write_failed',
      details: { proposalId: id, reason: 'outside_project' },
    })
    expect(h.forwarded).toEqual([])
    h.file.failWith = undefined
    expect(await h.tap(id, 'approve')).toBe('approved')
    expect(h.file.appended).toHaveLength(1)
  })

  test('Reject writes nothing and tells the session', async () => {
    const h = harness()
    const id = await h.proposed()
    expect(await h.tap(id, 'reject')).toBe('rejected')
    expect(h.file.appended).toEqual([])
    expect(h.store.findById(id)?.state).toBe('rejected')
    expect(h.forwarded[0]?.text).toContain('rejected')
    expect(h.gateway.edits.at(-1)?.keyboard).toEqual([])
    expect(h.audit.events.at(-1)).toBe('memory.rejected')
  })

  test('a sender who is not allowed, another chat or another session changes nothing', async () => {
    const h = harness()
    const id = await h.proposed()
    expect(await h.tap(id, 'approve', { sender: MALLORY })).toBe('not_allowed')
    expect(await h.tap(id, 'approve', { chatId: '999' })).toBe('not_found')
    expect(await h.tap('zzzzzzzzzz', 'approve')).toBe('not_found')
    const other = MemoryProposal.open({
      id: 'bbbbbbbbbb',
      session: 'other',
      chatId: ALICE.id,
      lines: ['x'],
      now: h.clock.now(),
    })
    h.store.put(other)
    expect(await h.tap(other.id, 'approve')).toBe('not_found')
    expect(h.file.appended).toEqual([])
    expect(h.store.findById(id)?.state).toBe('pending')
  })

  test('after the TTL a tap expires it and writes nothing', async () => {
    const h = harness()
    const id = await h.proposed()
    h.clock.advance(MEMORY_PROPOSAL_TTL_MS)
    expect(await h.tap(id, 'approve')).toBe('expired')
    expect(h.file.appended).toEqual([])
    expect(h.store.findById(id)?.state).toBe('expired')
    expect(await h.tap(id, 'approve')).toBe('expired')
  })
})

describe('ExpireMemoryProposals', () => {
  test('expires this session’s proposals past the TTL and removes their buttons', async () => {
    const h = harness()
    const id = await h.proposed()
    expect(await h.expire.execute()).toBe(0)
    h.clock.advance(MEMORY_PROPOSAL_TTL_MS)
    expect(await h.expire.execute()).toBe(1)
    expect(h.store.findById(id)?.state).toBe('expired')
    expect(h.gateway.edits.at(-1)?.keyboard).toEqual([])
    expect(h.audit.entries.at(-1)).toMatchObject({
      event: 'memory.expired',
      details: { proposalId: id, reason: 'ttl' },
    })
    expect(h.file.appended).toEqual([])
    expect(h.forwarded).toEqual([])
  })

  test('cancels proposals of another session', async () => {
    const h = harness()
    const mine = await h.proposed()
    h.store.put(
      MemoryProposal.open({
        id: 'bbbbbbbbbb',
        session: 'gone',
        chatId: ALICE.id,
        lines: ['x'],
        now: h.clock.now(),
      }).withPrompt({ chatId: ALICE.id, messageId: '9' }),
    )
    expect(await h.expire.expireOrphans()).toBe(1)
    expect(h.store.findById('bbbbbbbbbb')?.state).toBe('cancelled')
    expect(h.store.findById(mine)?.state).toBe('pending')
  })
})

describe('/wrap', () => {
  function wrapHarness() {
    const delivered: InboundMessage[] = []
    const brake = new InMemoryBrakeFlag()
    const audit = new InMemoryAuditLog()
    const wrap = new RequestSessionWrap({
      deliver: async (message) => {
        delivered.push(message)
      },
      brake,
      messages: en,
      audit,
      clock: new FakeClock(),
    })
    return { delivered, brake, audit, wrap }
  }

  test('feeds the fixed catalog instruction into the inbound chain, nothing interpolated', async () => {
    const h = wrapHarness()
    expect(await h.wrap.execute({ chatId: ALICE.id, sender: ALICE })).toBe('sent')
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toMatchObject({ chatId: ALICE.id, sender: ALICE, chatKind: 'private' })
    expect(h.delivered[0]?.text).toBe(en.wrapInstruction)
    expect(en.wrapInstruction).toContain('save_session_summary')
    expect(en.wrapInstruction).toContain('propose_memory')
    expect(messagesFor('es').wrapInstruction).toContain('save_session_summary')
    expect(h.audit.entries).toMatchObject([
      { event: 'wrap.requested', details: { chatId: ALICE.id } },
    ])
  })

  test('braked: nothing is sent', async () => {
    const h = wrapHarness()
    h.brake.engage({ engagedAt: 0, by: 'cli', reason: undefined } as never)
    expect(await h.wrap.execute({ chatId: ALICE.id, sender: ALICE })).toBe('braked')
    expect(h.delivered).toEqual([])
  })

  test('the command answers in the chat', async () => {
    const replies: string[] = []
    const command = new WrapCommand(
      'd',
      { execute: async () => 'braked' },
      {
        sent: 'S',
        braked: 'B',
      },
    )
    expect(command.name).toBe('wrap')
    await command.execute({
      chatId: ALICE.id,
      sender: ALICE,
      args: 'ignored text',
      reply: async (text) => {
        replies.push(text)
      },
    })
    expect(replies).toEqual(['B'])
  })
})
