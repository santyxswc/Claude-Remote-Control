import { describe, expect, test } from 'bun:test'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import type { AttachmentInbox, InboxDraft } from '../../../src/application/ports/AttachmentInbox.ts'
import type {
  AttachmentSource,
  RemoteFile,
} from '../../../src/application/ports/AttachmentSource.ts'
import type { ForwardableMessage } from '../../../src/application/use-cases/HandleInboundMessage.ts'
import {
  type AttachmentMessage,
  ReceiveAttachment,
} from '../../../src/application/use-cases/ReceiveAttachment.ts'
import { SweepInbox } from '../../../src/application/use-cases/SweepInbox.ts'
import type { InboxEntry } from '../../../src/domain/attachments/inboxRetention.ts'
import { TokenBucket } from '../../../src/domain/TokenBucket.ts'
import { ALICE, FakeChatGateway, FakeClock, InMemoryAuditLog, MemoryLogger } from '../../fakes.ts'

const en = messagesFor('en')
const PDF = new TextEncoder().encode('%PDF-1.7 hello world')

function padded(head: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length).fill(32)
  out.set(head)
  return out
}

type Served = { bytes: Uint8Array; size?: number; chunk?: number; fail?: Error; hang?: boolean }

class FakeSource implements AttachmentSource {
  readonly files = new Map<string, Served>()
  readonly opened: string[] = []
  async open(fileId: string, signal: AbortSignal): Promise<RemoteFile> {
    this.opened.push(fileId)
    const file = this.files.get(fileId)
    if (file === undefined) throw new Error('no such file')
    if (file.fail !== undefined) throw file.fail
    const { bytes, hang } = file
    const step = Math.max(1, file.chunk ?? bytes.length)
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (let at = 0; at < bytes.length; at += step) yield bytes.slice(at, at + step)
      if (hang === true) {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        )
      }
    }
    return { size: file.size, chunks: chunks() }
  }
}

class MemoryInbox implements AttachmentInbox {
  readonly kept = new Map<string, Uint8Array>()
  readonly drafts = new Set<string>()
  discarded = 0
  #next = 0
  async draft(extension: string): Promise<InboxDraft> {
    const name = `${String(this.#next++).padStart(32, '0')}.${extension}`
    const parts: Uint8Array[] = []
    this.drafts.add(name)
    return {
      write: async (chunk) => void parts.push(chunk),
      keep: async () => {
        this.drafts.delete(name)
        this.kept.set(name, Buffer.concat(parts))
        return `/inbox/${name}`
      },
      discard: async () => {
        this.drafts.delete(name)
        this.discarded += 1
      },
    }
  }
  async list(): Promise<readonly InboxEntry[]> {
    return [...this.kept].map(([name, bytes]) => ({ name, bytes: bytes.length, modifiedAt: 0 }))
  }
  async remove(names: readonly string[]): Promise<number> {
    for (const name of names) this.kept.delete(name)
    return names.length
  }
  async removeOtherSessions(): Promise<number> {
    return 0
  }
}

function harness(options: { maxBytes?: number; budget?: TokenBucket; maxInFlight?: number } = {}) {
  const source = new FakeSource()
  const inbox = new MemoryInbox()
  const chat = new FakeChatGateway()
  const audit = new InMemoryAuditLog()
  const clock = new FakeClock()
  const logger = new MemoryLogger()
  const forwarded: ForwardableMessage[] = []
  let kept = 0
  const receive = new ReceiveAttachment({
    source,
    inbox,
    forward: {
      execute: async (m) => {
        forwarded.push(m)
        return 'forwarded'
      },
    },
    chat,
    messages: en,
    maxBytes: options.maxBytes ?? 1_000,
    audit,
    clock,
    logger,
    afterKeep: async () => {
      kept += 1
    },
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
  })
  const settle = async () => {
    for (let i = 0; i < 200 && receive.pending > 0; i++) await Bun.sleep(1)
    await Bun.sleep(1)
  }
  return { source, inbox, chat, audit, logger, forwarded, receive, settle, keptCount: () => kept }
}

let nextMessage = 1
function doc(
  fileName: string | undefined,
  extra: Partial<AttachmentMessage> = {},
): AttachmentMessage {
  return {
    chatId: ALICE.id,
    messageId: String(nextMessage++),
    chatKind: 'private',
    sender: ALICE,
    sentAt: 0,
    attachment: {
      kind: 'document',
      fileId: 'f',
      ...(fileName === undefined ? {} : { fileName }),
      size: undefined,
    },
    ...extra,
  } as AttachmentMessage
}

describe('ReceiveAttachment', () => {
  test('a good file is kept, forwarded with its path and audited without its name', async () => {
    const h = harness()
    h.source.files.set('f', { bytes: PDF, chunk: 3 })
    h.receive.start(doc('Secret Plans.pdf', { caption: '  look  ' }))
    await h.settle()
    expect([...h.inbox.kept.values()]).toEqual([PDF])
    expect(h.forwarded[0]?.text).toBe(`look\n\nAttachment saved at: /inbox/${'0'.repeat(32)}.pdf`)
    expect(h.forwarded[0]?.forwardContext).toEqual({
      kind: 'attachment',
      path: `/inbox/${'0'.repeat(32)}.pdf`,
      name: 'Secret Plans.pdf',
      mime: 'application/pdf',
      size: PDF.length,
    })
    expect(h.audit.events).toEqual(['attachment.received'])
    expect(JSON.stringify(h.audit.entries)).not.toContain('Secret')
    expect(JSON.stringify(h.audit.entries)).not.toContain('look')
    expect(h.keptCount()).toBe(1)
    expect(h.chat.sent).toEqual([])
  })

  test('a photo picks the largest size that fits and is a jpg', async () => {
    const h = harness({ maxBytes: 100 })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    h.source.files.set('m', { bytes: jpeg })
    h.receive.start({
      ...doc(undefined),
      attachment: {
        kind: 'photo',
        sizes: [
          { fileId: 's', width: 10, height: 10, size: 10 },
          { fileId: 'm', width: 100, height: 100, size: 90 },
          { fileId: 'l', width: 1000, height: 1000, size: 1000 },
        ],
      },
    })
    await h.settle()
    expect(h.source.opened).toEqual(['m'])
    expect(h.forwarded[0]?.text).toStartWith('The user sent a photo.')
    expect(h.forwarded[0]?.forwardContext).toMatchObject({ name: 'photo.jpg', mime: 'image/jpeg' })
  })

  test.each([
    ['type_not_allowed', 'run.exe', { bytes: PDF }],
    ['type_not_allowed', undefined, { bytes: PDF }],
    ['type_mismatch', 'a.png', { bytes: PDF }],
    ['type_mismatch', 'a.txt', { bytes: new Uint8Array([97, 0, 98]) }],
    ['type_mismatch', 'a.txt', { bytes: PDF }],
    ['too_large', 'a.pdf', { bytes: PDF, size: 5_000 }],
    ['too_large', 'a.pdf', { bytes: padded(PDF, 2_000), chunk: 100 }],
    ['empty', 'a.txt', { bytes: new Uint8Array(0) }],
    ['download_failed', 'a.pdf', { bytes: PDF, fail: new Error('boom') }],
  ] as const)('refused: %s (%p)', async (reason, name, served) => {
    const h = harness()
    h.source.files.set('f', { ...served, bytes: served.bytes })
    h.receive.start(doc(name))
    await h.settle()
    expect(h.forwarded).toEqual([])
    expect(h.inbox.kept.size).toBe(0)
    expect(h.inbox.drafts.size).toBe(0)
    expect(h.audit.entries.map(({ details: { reason } }) => reason)).toEqual([reason])
    expect(h.chat.sent).toHaveLength(1)
  })

  test('the declared size of the message is checked before any download', async () => {
    const h = harness()
    h.receive.start({
      ...doc('a.pdf'),
      attachment: { kind: 'document', fileId: 'f', fileName: 'a.pdf', size: 1_001 },
    })
    await h.settle()
    expect(h.source.opened).toEqual([])
    expect(h.audit.entries[0]?.details).toMatchObject({ reason: 'too_large' })
  })

  test('the per-sender budget refuses a flood, one notice per window', async () => {
    const h = harness({
      budget: new TokenBucket({ burst: 2, refillMs: 60_000, noticeWindowMs: 60_000 }),
    })
    h.source.files.set('f', { bytes: PDF })
    for (let i = 0; i < 4; i++) h.receive.start(doc('a.pdf', { mediaGroupId: 'g' }))
    await h.settle()
    expect(h.forwarded).toHaveLength(2)
    expect(
      h.audit.entries.filter(({ details: { reason } }) => reason === 'rate_limited'),
    ).toHaveLength(2)
    expect(h.chat.sent).toHaveLength(1)
  })

  test('at most maxInFlight downloads at a time', async () => {
    const h = harness({ maxInFlight: 2 })
    h.source.files.set('f', { bytes: PDF, hang: true })
    for (let i = 0; i < 3; i++) h.receive.start(doc('a.pdf'))
    for (let i = 0; i < 500 && h.source.opened.length < 2; i++) await Bun.sleep(1)
    await Bun.sleep(1)
    expect(h.source.opened).toHaveLength(2)
    expect(h.receive.pending).toBe(3)
    await h.receive.stop()
    expect(h.receive.pending).toBe(0)
    expect(h.inbox.drafts.size).toBe(0)
    expect(h.forwarded).toEqual([])
    // Nothing is accepted after stop.
    h.receive.start(doc('a.pdf'))
    expect(h.receive.pending).toBe(0)
  })
})

describe('SweepInbox', () => {
  test('removes what the retention policy selects', async () => {
    const inbox = new MemoryInbox()
    inbox.kept.set('a', new Uint8Array(60))
    inbox.kept.set('b', new Uint8Array(60))
    const sweep = new SweepInbox(inbox, new FakeClock(0), new MemoryLogger(), {
      ttlMs: 1_000,
      quotaBytes: 100,
    })
    expect(await sweep.execute()).toBe(1)
    expect(inbox.kept.size).toBe(1)
    expect(await sweep.execute()).toBe(0)
    expect(await sweep.orphans()).toBe(0)
  })
})
