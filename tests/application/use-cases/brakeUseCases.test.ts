/** EngageBrake, ResumeSession and StopSession over in-memory fakes. */
import { describe, expect, test } from 'bun:test'
import type { PromptGateway } from '../../../src/application/ports/PromptGateway.ts'
import { EngageBrake } from '../../../src/application/use-cases/EngageBrake.ts'
import { ResumeSession } from '../../../src/application/use-cases/ResumeSession.ts'
import { StopSession } from '../../../src/application/use-cases/StopSession.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { PermissionRequest } from '../../../src/domain/permissions/PermissionRequest.ts'
import { ALICE, BOB, FakePromptGateway, FakeSessionController } from '../../fakes.ts'
import { en, incoming, permissionHarness } from '../permissionHarness.ts'

function harness(
  controller = new FakeSessionController('sent'),
  prompts: PromptGateway | undefined = undefined,
) {
  const h = permissionHarness(prompts === undefined ? {} : { prompts })
  const common = { brake: h.brake, audit: h.audit, clock: h.clock, logger: h.logger }
  const engage = new EngageBrake(common)
  return {
    ...h,
    controller,
    engage,
    resume: new ResumeSession(common),
    stop: new StopSession({
      engage,
      store: h.store,
      resolve: h.resolve,
      controller,
      audit: h.audit,
      clock: h.clock,
      logger: h.logger,
      session: 'session-1',
    }),
  }
}

describe('EngageBrake', () => {
  test('engages once with a sanitized reason; the audit has its length, not its text', () => {
    const h = harness()
    const first = h.engage.execute({ actor: 'terminal', reason: ' deploy\nis wrong ' })
    expect(first).toEqual({
      outcome: 'engaged',
      record: { engagedAt: h.clock.now(), actor: 'terminal', reason: 'deploy is wrong' },
    })
    h.clock.advance(1000)
    const second = h.engage.execute({ actor: 'telegram:1' })
    expect(second).toEqual({ outcome: 'already_engaged', record: first.record })
    expect(h.audit.entries).toEqual([
      {
        at: first.record?.engagedAt ?? 0,
        actor: 'terminal',
        event: 'brake.engaged',
        details: { reasonLength: 15 },
      },
    ])
    expect(JSON.stringify(h.audit.entries)).not.toContain('deploy')
  })

  test('an unreadable flag is already engaged and is left alone', () => {
    const h = harness()
    h.brake.unreadable = true
    expect(h.engage.execute({ actor: 'terminal' })).toEqual({
      outcome: 'already_engaged',
      record: undefined,
    })
    expect(h.brake.unreadable).toBe(true)
  })
})

describe('ResumeSession', () => {
  test('releases once and audits; then reports it was not engaged', () => {
    const h = harness()
    h.engage.execute({ actor: 'terminal' })
    expect(h.resume.execute('telegram:1')).toBe('released')
    expect(h.brake.status()).toEqual({ engaged: false })
    expect(h.resume.execute('telegram:1')).toBe('not_engaged')
    expect(h.audit.entries.filter((e) => e.event === 'brake.released')).toEqual([
      { at: h.clock.now(), actor: 'telegram:1', event: 'brake.released', details: {} },
    ])
  })
})

describe('StopSession', () => {
  test('M1: a slow prompt edit (flood wait) holds up neither the interrupt nor other verdicts', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts = new FakePromptGateway()
    prompts.editPrompt = () => gate
    const controller = new FakeSessionController('sent')
    const h = harness(controller, prompts)
    await h.relay.execute(incoming({ requestId: 'abcde' }))
    await h.relay.execute(incoming({ requestId: 'fghij' }))

    const stopping = h.stop.execute({ sender: ALICE })
    expect(h.brake.status().engaged).toBe(true) // before anything is awaited
    for (let i = 0; i < 50 && (controller.calls < 1 || h.verdicts.sent.length < 2); i++) {
      await Promise.resolve()
    }
    expect(controller.calls).toBe(1)
    expect(h.verdicts.sent.map((v) => v.requestId)).toEqual(['abcde', 'fghij'])

    release()
    expect((await stopping).denied).toBe(2)
  })

  test('brake, one deny per pending request of this session, interrupt, audit', async () => {
    const h = harness()
    h.allowed.add(allowSender(BOB, h.clock.now()))
    await h.relay.execute(incoming({ requestId: 'abcde' }))
    await h.relay.execute(incoming({ requestId: 'fghij' }))
    // Another process's request is not ours to answer.
    h.store.put(
      PermissionRequest.open({
        id: 'kmnop',
        session: 'other',
        toolName: 'Bash',
        description: '',
        inputPreview: '{}',
        risk: 'low',
        now: h.clock.now(),
      }),
    )

    const report = await h.stop.execute({ sender: ALICE, reason: 'wrong repo' })

    expect(report).toEqual({
      brake: 'engaged',
      record: { engagedAt: h.clock.now(), actor: `telegram:${ALICE.id}`, reason: 'wrong repo' },
      denied: 2,
      interrupt: 'sent',
    })
    expect(h.brake.status().engaged).toBe(true)
    expect(h.verdicts.sent).toEqual([
      { requestId: 'abcde', behavior: 'deny' },
      { requestId: 'fghij', behavior: 'deny' },
    ])
    expect(h.store.findById('kmnop')?.state).toBe('pending')
    expect(h.controller.calls).toBe(1)
    // Every copy (Alice's and Bob's) loses its buttons and says why.
    const at = new Date(h.clock.now()).toISOString()
    expect(h.gateway.edits).toHaveLength(4)
    for (const edit of h.gateway.edits) {
      expect(edit.keyboard).toEqual([])
      expect(edit.text).toContain(en.permissionDeniedByStop({ who: '@alice', at }))
    }
    const events = h.audit.entries.map(({ event, details: { via } }) => [event, via ?? null])
    expect(events.filter(([event]) => event !== 'permission.relayed')).toEqual([
      ['brake.engaged', null],
      ['permission.denied', 'stop'],
      ['permission.denied', 'stop'],
      ['session.stopped', null],
    ])
    expect(h.audit.entries.at(-1)?.details).toEqual({ denied: 2, interrupt: 'sent' })
  })

  test('a second /stop is idempotent: no interrupt, no new audit', async () => {
    const h = harness()
    const first = await h.stop.execute({ sender: ALICE })
    const audited = h.audit.entries.length
    h.clock.advance(5000)
    const second = await h.stop.execute({ sender: ALICE })
    expect(second).toEqual({
      brake: 'already_engaged',
      record: first.record,
      denied: 0,
      interrupt: 'skipped',
    })
    expect(h.controller.calls).toBe(1)
    expect(h.audit.entries).toHaveLength(audited)
  })

  test('reports truthfully when no interrupt is possible or it fails', async () => {
    expect(
      (await harness(new FakeSessionController('unavailable')).stop.execute({ sender: ALICE }))
        .interrupt,
    ).toBe('unavailable')
    const broken = harness(new FakeSessionController(new Error('boom')))
    expect((await broken.stop.execute({ sender: ALICE })).interrupt).toBe('failed')
  })

  test('a deny that cannot be delivered is not counted', async () => {
    const h = harness()
    await h.relay.execute(incoming())
    h.verdicts.failWith = new Error('transport closed')
    const report = await h.stop.execute({ sender: ALICE })
    expect(report.denied).toBe(0)
    expect(h.brake.status().engaged).toBe(true)
  })
})

describe('the permission relay while braked', () => {
  test('a new request is denied at once and never relayed or stored', async () => {
    const h = harness()
    h.engage.execute({ actor: 'terminal' })
    expect(await h.relay.execute(incoming())).toBe('denied_by_brake')
    expect(h.verdicts.sent).toEqual([{ requestId: 'abcde', behavior: 'deny' }])
    expect(h.gateway.sent).toEqual([])
    expect(h.store.findById('abcde')).toBeUndefined()
    expect(h.audit.entries.at(-1)).toMatchObject({
      actor: 'system',
      event: 'permission.denied',
      details: { requestId: 'abcde', via: 'brake' },
    })
  })

  test('also when this process does not poll', async () => {
    const h = harness()
    h.setPolling(false)
    h.brake.unreadable = true
    expect(await h.relay.execute(incoming())).toBe('denied_by_brake')
    expect(h.verdicts.sent).toHaveLength(1)
  })

  test('a prompt left open (CLI stop) cannot be approved, but can be denied', async () => {
    const h = harness()
    await h.relay.execute(incoming())
    h.engage.execute({ actor: 'terminal' })
    const tap = (action: 'approve' | 'deny') =>
      h.resolve.execute({ requestId: 'abcde', action, sender: ALICE, via: 'button' })
    expect(await tap('approve')).toBe('braked')
    expect(h.verdicts.sent).toEqual([])
    expect(h.store.findById('abcde')?.state).toBe('pending')
    expect(await tap('deny')).toBe('denied')
    expect(h.verdicts.sent).toEqual([{ requestId: 'abcde', behavior: 'deny' }])
  })
})
