import { describe, expect, test } from 'bun:test'
import { AuthorizeReplyTarget } from '../../../src/application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { CaptureScreenshot } from '../../../src/application/use-cases/CaptureScreenshot.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import type { CaptureKind } from '../../../src/domain/capture/CaptureTarget.ts'
import {
  ALICE,
  FakeCapturer,
  FakeCaptureScratch,
  FakeClock,
  FakeImageGateway,
  InMemoryAllowedSenders,
  InMemoryAuditLog,
  MALLORY,
  MemoryLogger,
} from '../../fakes.ts'
import { makePng } from '../../png.ts'

function setup(kinds: readonly CaptureKind[] = ['screen', 'url']) {
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, 0))
  const scratch = new FakeCaptureScratch()
  const capturer = new FakeCapturer(kinds, scratch, makePng(1280, 800))
  const images = new FakeImageGateway()
  const audit = new InMemoryAuditLog()
  const logger = new MemoryLogger()
  const useCase = new CaptureScreenshot({
    capturers: kinds.length === 0 ? [] : [capturer],
    unavailable: { url: { reason: 'no_browser', remedies: ['chromium'] } },
    scratch,
    images,
    target: new AuthorizeReplyTarget(new AuthorizeSender(allowed)),
    caption: (target) => (target.kind === 'screen' ? 'screen!' : `page ${target.url}`),
    audit,
    clock: new FakeClock(),
    logger,
  })
  return { allowed, scratch, capturer, images, audit, logger, useCase }
}

const ACTOR = `telegram:${ALICE.id}`

describe('CaptureScreenshot', () => {
  test('captures the screen, sends a photo with the caption, cleans up and audits', async () => {
    const { useCase, images, scratch, audit, capturer } = setup()
    const outcome = await useCase.execute({ chatId: ALICE.id, actor: ACTOR })
    const bytes = makePng(1280, 800).length
    expect(outcome).toEqual({ status: 'sent', as: 'photo', bytes })
    expect(capturer.targets).toEqual([{ kind: 'screen' }])
    expect(images.sent).toEqual([
      {
        chatId: ALICE.id,
        image: { path: 'scratch-0/image.png', filename: 'screenshot.png', as: 'photo' },
        caption: 'screen!',
      },
    ])
    expect(scratch.live).toBe(0)
    expect(scratch.files.size).toBe(0)
    expect(audit.entries).toMatchObject([
      {
        actor: ACTOR,
        event: 'screenshot.sent',
        details: { chatId: ALICE.id, kind: 'screen', outcome: 'sent', as: 'photo', bytes },
      },
    ])
  })

  test('a page: normalized URL to the capturer, only the host in the audit', async () => {
    const { useCase, images, audit, capturer } = setup()
    const outcome = await useCase.execute({
      chatId: ALICE.id,
      actor: 'session',
      url: 'localhost:3000/admin?token=s3cr3t-value',
    })
    expect(outcome.status).toBe('sent')
    expect(capturer.targets).toEqual([
      {
        kind: 'url',
        url: 'http://localhost:3000/admin?token=s3cr3t-value',
        host: 'localhost:3000',
      },
    ])
    expect(images.sent[0]?.caption).toBe('page http://localhost:3000/admin?token=s3cr3t-value')
    expect(audit.entries[0]?.details).toMatchObject({ kind: 'url', host: 'localhost:3000' })
    expect(JSON.stringify(audit.entries)).not.toContain('admin')
    expect(JSON.stringify(audit.entries)).not.toContain('s3cr3t')
  })

  test('too wide for a photo: sent as a document', async () => {
    const { useCase, images, capturer } = setup()
    capturer.image = makePng(7680, 2400)
    expect(await useCase.execute({ chatId: ALICE.id, actor: ACTOR })).toMatchObject({
      status: 'sent',
      as: 'document',
    })
    expect(images.sent[0]?.image.as).toBe('document')
  })

  test('a chat that is not an allowlisted private chat is refused before anything runs', async () => {
    for (const chatId of [MALLORY.id, '-1001234567890', '@channel', 'dev']) {
      const { useCase, capturer, scratch, images, audit } = setup()
      expect(await useCase.execute({ chatId, actor: 'session' })).toEqual({
        status: 'refused',
        reason: 'chat_not_allowed',
      })
      expect(capturer.targets).toEqual([])
      expect(scratch.created).toBe(0)
      expect(images.sent).toEqual([])
      expect(audit.entries[0]).toMatchObject({
        event: 'screenshot.not_sent',
        details: { outcome: 'refused', reason: 'chat_not_allowed' },
      })
    }
  })

  test('revoking the sender stops screenshots at once', async () => {
    const { useCase, allowed } = setup()
    allowed.remove(ALICE.id)
    expect((await useCase.execute({ chatId: ALICE.id, actor: 'session' })).status).toBe('refused')
  })

  test.each([['file:///etc/passwd'], ['javascript:alert(1)'], ['http://u:p@localhost'], ['-x']])(
    '%p is refused by the URL policy and nothing runs',
    async (url) => {
      const { useCase, capturer, scratch, audit } = setup()
      const outcome = await useCase.execute({ chatId: ALICE.id, actor: ACTOR, url })
      expect(outcome.status).toBe('invalid_url')
      expect(capturer.targets).toEqual([])
      expect(scratch.created).toBe(0)
      expect(audit.entries[0]?.details).toMatchObject({ kind: 'url', outcome: 'invalid_url' })
      expect(JSON.stringify(audit.entries)).not.toContain(url)
    },
  )

  test('a kind no strategy covers is unavailable, with why and what would enable it', async () => {
    const { useCase, scratch } = setup(['screen'])
    expect(useCase.availableKinds()).toEqual(['screen'])
    expect(
      await useCase.execute({ chatId: ALICE.id, actor: ACTOR, url: 'localhost:3000' }),
    ).toEqual({
      status: 'unavailable',
      kind: 'url',
      detail: { reason: 'no_browser', remedies: ['chromium'] },
    })
    expect(scratch.created).toBe(0)
    expect(setup([]).useCase.availableKinds()).toEqual([])
  })

  test('one capture at a time: a second request while one runs is busy', async () => {
    const { useCase, capturer, images } = setup()
    let release = () => {}
    capturer.gate = new Promise((resolve) => {
      release = resolve
    })
    const first = useCase.execute({ chatId: ALICE.id, actor: ACTOR })
    await Bun.sleep(0)
    expect(await useCase.execute({ chatId: ALICE.id, actor: 'session', url: 'localhost' })).toEqual(
      {
        status: 'refused',
        reason: 'busy',
      },
    )
    release()
    expect((await first).status).toBe('sent')
    capturer.gate = undefined
    expect((await useCase.execute({ chatId: ALICE.id, actor: ACTOR })).status).toBe('sent')
    expect(images.sent).toHaveLength(2)
  })

  test('a failing capture still removes the workspace and frees the slot', async () => {
    const { useCase, capturer, scratch, images, logger, audit } = setup()
    capturer.failWith = new Error('grim: compositor does not support screencopy')
    expect(await useCase.execute({ chatId: ALICE.id, actor: ACTOR })).toEqual({
      status: 'failed',
      stage: 'capture',
      error: 'grim: compositor does not support screencopy',
    })
    expect(scratch.live).toBe(0)
    expect(images.sent).toEqual([])
    expect(logger.entries.at(-1)?.level).toBe('error')
    expect(audit.entries[0]?.details).toMatchObject({ outcome: 'failed', stage: 'capture' })
    capturer.failWith = undefined
    expect((await useCase.execute({ chatId: ALICE.id, actor: ACTOR })).status).toBe('sent')
  })

  test('a failing send still removes the workspace', async () => {
    const { useCase, images, scratch } = setup()
    images.failWith = new Error('Telegram said no')
    expect(await useCase.execute({ chatId: ALICE.id, actor: ACTOR })).toEqual({
      status: 'failed',
      stage: 'send',
      error: 'Telegram said no',
    })
    expect(scratch.live).toBe(0)
    expect(scratch.files.size).toBe(0)
  })

  test('an empty or oversized image is never sent silently', async () => {
    const { useCase, capturer, images, scratch } = setup()
    capturer.image = new Uint8Array(0)
    expect((await useCase.execute({ chatId: ALICE.id, actor: ACTOR })).status).toBe('failed')
    capturer.image = new Uint8Array(50_000_001)
    expect(await useCase.execute({ chatId: ALICE.id, actor: ACTOR })).toEqual({
      status: 'too_large',
      bytes: 50_000_001,
    })
    expect(images.sent).toEqual([])
    expect(scratch.live).toBe(0)
  })
})
