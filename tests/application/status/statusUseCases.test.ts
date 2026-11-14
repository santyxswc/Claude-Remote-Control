/** F9 in the application layer: rendering, /pin, /unpin and the updater. */
import { describe, expect, test } from 'bun:test'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { RedactingStatusGateway } from '../../../src/application/outbound/RedactingStatusGateway.ts'
import {
  StatusFloodWaitError,
  StatusMessageGoneError,
} from '../../../src/application/ports/StatusMessageGateway.ts'
import { clockTime, StatusBoard } from '../../../src/application/status/StatusBoard.ts'
import { PinStatusMessage } from '../../../src/application/use-cases/PinStatusMessage.ts'
import { UnpinStatusMessage } from '../../../src/application/use-cases/UnpinStatusMessage.ts'
import { UpdateStatusMessages } from '../../../src/application/use-cases/UpdateStatusMessages.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { REDACTION_MARK } from '../../../src/domain/redaction/SecretRedactor.ts'
import { createSecretRedactor } from '../../../src/domain/redaction/secretValues.ts'
import {
  STATUS_DEBOUNCE_MS,
  STATUS_MIN_INTERVAL_MS,
} from '../../../src/domain/status/StatusUpdatePolicy.ts'
import { summarizeToolUse } from '../../../src/domain/status/toolActivity.ts'
import {
  ALICE,
  BOB,
  FakeClock,
  FakeStatusGateway,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  InMemoryBrakeFlag,
  InMemoryStatusMessageStore,
  MemoryLogger,
} from '../../fakes.ts'

const en = messagesFor('en')
const es = messagesFor('es')

function harness(options: { project?: string | undefined } = {}) {
  const clock = new FakeClock()
  const brake = new InMemoryBrakeFlag()
  let permissions = 0
  let choices = 0
  const board = new StatusBoard({
    brake,
    pendingPermissions: () => permissions,
    pendingChoices: () => choices,
    project: 'project' in options ? options.project : 'demo',
    messages: en,
    clock,
  })
  const gateway = new FakeStatusGateway()
  const store = new InMemoryStatusMessageStore()
  const audit = new InMemoryAuditLog()
  const logger = new MemoryLogger()
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, clock.now()))
  allowed.add(allowSender(BOB, clock.now()))
  let polling = true
  const deps = { board, gateway, store, audit, clock, logger }
  return {
    clock,
    brake,
    board,
    gateway,
    store,
    audit,
    logger,
    allowed,
    setPending: (p: number, c: number) => {
      permissions = p
      choices = c
    },
    setPolling: (value: boolean) => {
      polling = value
    },
    pin: new PinStatusMessage(deps),
    unpin: new UnpinStatusMessage(deps),
    update: new UpdateStatusMessages({ ...deps, allowed, canEdit: () => polling }),
  }
}

/** Ticks once per second for `ms`, like the timer does. */
async function run(h: ReturnType<typeof harness>, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1_000) {
    h.clock.advance(1_000)
    await h.update.tick()
  }
}

describe('StatusBoard rendering', () => {
  test('unknown before any hook event', () => {
    const h = harness()
    expect(h.board.render()).toBe('📌 Claude Code · demo\nState: unknown (no hook events yet)')
  })

  test('working, last tool, pending prompts, last finished', () => {
    const h = harness()
    h.board.record({ kind: 'turn_ended' })
    const finished = clockTime(h.clock.now())
    h.clock.advance(60_000)
    h.board.record({ kind: 'turn_started' })
    const since = clockTime(h.clock.now())
    h.board.record({
      kind: 'tool_ran',
      activity: summarizeToolUse('Bash', { command: 'cat .env', description: 'Show the config' }),
    })
    expect(h.board.render()).toBe(
      [
        '📌 Claude Code · demo',
        `State: working since ${since}`,
        'Last tool: Bash · Show the config',
        `Last finished: ${finished}`,
      ].join('\n'),
    )
    h.setPending(2, 1)
    expect(h.board.render()).toContain('State: waiting for your answer\n')
    expect(h.board.render()).toContain('Waiting for you: 2 permissions, 1 questions')
    expect(h.board.render()).not.toContain('cat .env')
  })

  test('braked wins over everything but the end', () => {
    const h = harness()
    h.board.record({ kind: 'turn_started' })
    h.brake.engage({ engagedAt: h.clock.now(), actor: 'terminal', reason: undefined })
    expect(h.board.view().state).toBe('braked')
    expect(h.board.render()).toContain(`braked since ${clockTime(h.clock.now())}`)
    h.board.record({ kind: 'ended' })
    expect(h.board.view()).toMatchObject({ state: 'ended', activity: undefined })
  })

  test('the project falls back to the hook cwd; untrusted names are shown plainly', () => {
    const h = harness({ project: undefined })
    h.board.record({ kind: 'turn_started' }, '/home/me/evil‮proj')
    expect(h.board.render()).not.toContain('‮')
    expect(h.board.view().project).toBeDefined()
  })

  test('Spanish', () => {
    const board = new StatusBoard({
      brake: new InMemoryBrakeFlag(),
      pendingPermissions: () => 0,
      pendingChoices: () => 0,
      project: 'demo',
      messages: es,
      clock: new FakeClock(),
    })
    board.record({ kind: 'turn_ended' })
    expect(board.render()).toContain('Estado: en espera desde las')
  })
})

describe('RedactingStatusGateway', () => {
  test('redacts and fits one message', async () => {
    const inner = new FakeStatusGateway()
    const gateway = new RedactingStatusGateway(
      inner,
      createSecretRedactor(['Zq8!vR2#pL-0042']),
      100,
    )
    const ref = await gateway.sendStatus('1', 'pw Zq8!vR2#pL-0042')
    await gateway.editStatus(ref, 'x'.repeat(500))
    await gateway.pinStatus(ref)
    expect(inner.calls[0]?.text).toBe(`pw ${REDACTION_MARK}`)
    expect(inner.calls[1]?.text?.length).toBeLessThanOrEqual(100)
    expect(inner.calls[2]).toEqual({ op: 'pin', ...ref })
  })
})

describe('/pin and /unpin', () => {
  test('pin sends, stores, audits and pins', async () => {
    const h = harness()
    expect(await h.pin.execute(ALICE.id)).toBe('pinned')
    expect(h.gateway.calls.map((c) => c.op)).toEqual(['send', 'pin'])
    expect(h.store.find(ALICE.id)).toEqual({ chatId: ALICE.id, messageId: '700' })
    expect(h.audit.events).toEqual(['status.pinned'])
  })

  test('pin again replaces the previous message', async () => {
    const h = harness()
    await h.pin.execute(ALICE.id)
    await h.pin.execute(ALICE.id)
    expect(h.gateway.calls.map((c) => `${c.op}:${c.messageId}`)).toEqual([
      'send:700',
      'pin:700',
      'unpin:700',
      'send:701',
      'pin:701',
    ])
    expect(h.store.list()).toEqual([{ chatId: ALICE.id, messageId: '701' }])
  })

  test('a send failure stores nothing; a pin failure still keeps the message', async () => {
    const h = harness()
    h.gateway.next.send = [new Error('403')]
    expect(await h.pin.execute(ALICE.id)).toBe('failed')
    expect(h.store.list()).toEqual([])
    h.gateway.next.pin = [new Error('not enough rights')]
    expect(await h.pin.execute(ALICE.id)).toBe('not_pinned')
    expect(h.store.list()).toHaveLength(1)
  })

  test('unpin forgets the message and stops updates', async () => {
    const h = harness()
    expect(await h.unpin.execute(ALICE.id)).toBe(false)
    await h.pin.execute(ALICE.id)
    expect(await h.unpin.execute(ALICE.id)).toBe(true)
    expect(h.gateway.ops('unpin')).toHaveLength(1)
    expect(h.store.list()).toEqual([])
    h.board.record({ kind: 'turn_started' })
    await run(h, 20_000)
    expect(h.gateway.ops('edit')).toEqual([])
    expect(h.audit.events).toEqual(['status.pinned', 'status.unpinned'])
  })

  test('an unpin that fails at Telegram still stops updates', async () => {
    const h = harness()
    await h.pin.execute(ALICE.id)
    h.gateway.next.unpin = [new Error('400')]
    expect(await h.unpin.execute(ALICE.id)).toBe(true)
    expect(h.store.list()).toEqual([])
  })
})

describe('UpdateStatusMessages', () => {
  test('a burst of hook events is one coalesced edit with the latest state', async () => {
    const h = harness()
    await h.pin.execute(ALICE.id)
    h.clock.advance(STATUS_MIN_INTERVAL_MS)
    h.board.record({ kind: 'turn_started' })
    for (const file of ['a.ts', 'b.ts', 'c.ts']) {
      h.board.record({ kind: 'tool_ran', activity: summarizeToolUse('Edit', { file_path: file }) })
      await h.update.tick()
    }
    expect(h.gateway.ops('edit')).toEqual([])
    await run(h, STATUS_DEBOUNCE_MS)
    const edits = h.gateway.ops('edit')
    expect(edits).toHaveLength(1)
    expect(edits[0]?.text).toContain('Last tool: Edit · c.ts')
  })

  test('an unchanged render never edits', async () => {
    const h = harness()
    await h.pin.execute(ALICE.id)
    await run(h, 120_000)
    expect(h.gateway.ops('edit')).toEqual([])
  })

  test('only the polling process edits', async () => {
    const h = harness()
    await h.pin.execute(ALICE.id)
    h.setPolling(false)
    h.board.record({ kind: 'turn_started' })
    await run(h, 20_000)
    expect(h.gateway.ops('edit')).toEqual([])
  })

  test('a flood wait backs off; the latest render goes after it', async () => {
    const h = harness()
    await h.pin.execute(ALICE.id)
    h.clock.advance(STATUS_MIN_INTERVAL_MS)
    h.gateway.next.edit = [new StatusFloodWaitError(30_000)]
    h.board.record({ kind: 'turn_started' })
    await run(h, STATUS_DEBOUNCE_MS)
    expect(h.gateway.ops('edit')).toEqual([])
    h.board.record({ kind: 'turn_ended' })
    await run(h, 25_000)
    expect(h.gateway.ops('edit')).toEqual([])
    await run(h, 10_000)
    const edits = h.gateway.ops('edit')
    expect(edits).toHaveLength(1)
    expect(edits[0]?.text).toContain('State: idle')
  })

  test('a deleted message is recreated and pinned once, then given up', async () => {
    const h = harness()
    await h.pin.execute(ALICE.id)
    h.clock.advance(STATUS_MIN_INTERVAL_MS)
    h.gateway.next.edit = [new StatusMessageGoneError(), new StatusMessageGoneError()]
    h.board.record({ kind: 'turn_started' })
    await run(h, STATUS_DEBOUNCE_MS + 1_000)
    expect(h.gateway.calls.map((c) => `${c.op}:${c.messageId}`)).toEqual([
      'send:700',
      'pin:700',
      'send:701',
      'pin:701',
    ])
    expect(h.store.find(ALICE.id)?.messageId).toBe('701')

    h.board.record({ kind: 'turn_ended' })
    await run(h, 20_000)
    expect(h.gateway.ops('send')).toHaveLength(2)
    expect(h.store.list()).toEqual([])
    h.board.record({ kind: 'turn_started' })
    await run(h, 20_000)
    expect(h.gateway.calls).toHaveLength(4)
  })

  test('a chat removed from the allowlist is dropped', async () => {
    const h = harness()
    await h.pin.execute(BOB.id)
    h.allowed.remove(BOB.id)
    h.board.record({ kind: 'turn_started' })
    await run(h, 20_000)
    expect(h.gateway.ops('edit')).toEqual([])
    expect(h.store.list()).toEqual([])
  })

  test('other failures keep the render and retry after the interval', async () => {
    const h = harness()
    await h.pin.execute(ALICE.id)
    h.clock.advance(STATUS_MIN_INTERVAL_MS)
    h.gateway.next.edit = [new Error('502')]
    h.board.record({ kind: 'turn_started' })
    // The change is first seen by the next tick; the failed edit is not recorded.
    await run(h, STATUS_DEBOUNCE_MS + 1_000)
    expect(h.gateway.ops('edit')).toHaveLength(0)
    await run(h, STATUS_MIN_INTERVAL_MS)
    expect(h.gateway.ops('edit')).toHaveLength(1)
  })

  test('finish: one last "session ended" edit at once, then nothing until resume', async () => {
    const h = harness()
    await h.pin.execute(ALICE.id)
    await h.pin.execute(BOB.id)
    h.board.record({ kind: 'turn_started' })
    await h.update.finish()
    const edits = h.gateway.ops('edit')
    expect(edits.map((e) => e.chatId).sort()).toEqual([ALICE.id, BOB.id].sort())
    expect(edits.every((e) => e.text?.includes('State: session ended'))).toBe(true)
    await h.update.finish()
    h.board.record({ kind: 'turn_started' })
    await run(h, 20_000)
    expect(h.gateway.ops('edit')).toHaveLength(2)

    h.update.resume()
    h.board.record({ kind: 'turn_started' })
    await run(h, 20_000)
    expect(h.gateway.ops('edit').length).toBeGreaterThan(2)
  })

  test('finish is best effort and skipped when another process polls', async () => {
    const h = harness()
    await h.pin.execute(ALICE.id)
    h.gateway.next.edit = [new Error('network')]
    await h.update.finish()
    expect(h.logger.entries.some((e) => e.message.includes('ended'))).toBe(true)

    const other = harness()
    await other.pin.execute(ALICE.id)
    other.setPolling(false)
    await other.update.finish()
    expect(other.gateway.ops('edit')).toEqual([])
  })
})
