import { describe, expect, test } from 'bun:test'
import { ButtonTapHandler } from '../../../src/application/callbacks/ButtonTapHandler.ts'
import { TranscriptionError } from '../../../src/application/errors.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import { RedactingPromptGateway } from '../../../src/application/outbound/RedactingPromptGateway.ts'
import { ChoiceTextAnswerStep } from '../../../src/application/pipeline/ChoiceTextAnswerStep.ts'
import { CommandRouterStep } from '../../../src/application/pipeline/CommandRouterStep.ts'
import { createTranscriptSteps } from '../../../src/application/pipeline/createSessionSteps.ts'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import { buildPipeline } from '../../../src/application/pipeline/InboundStep.ts'
import { PermissionVerdictStep } from '../../../src/application/pipeline/PermissionVerdictStep.ts'
import { UnsupportedContentStep } from '../../../src/application/pipeline/UnsupportedContentStep.ts'
import { VoiceNoteStep } from '../../../src/application/pipeline/VoiceNoteStep.ts'
import type { AttachmentSource } from '../../../src/application/ports/AttachmentSource.ts'
import type { AudioDraft, AudioScratch } from '../../../src/application/ports/AudioScratch.ts'
import type {
  RawTranscript,
  Transcriber,
  TranscriberAvailability,
} from '../../../src/application/ports/Transcriber.ts'
import type { VoiceTranscriptStore } from '../../../src/application/ports/VoiceTranscriptStore.ts'
import { AuthorizeSender } from '../../../src/application/use-cases/AuthorizeSender.ts'
import { ExpireVoiceTranscripts } from '../../../src/application/use-cases/ExpireVoiceTranscripts.ts'
import {
  ReceiveVoiceNote,
  type VoiceMessage,
} from '../../../src/application/use-cases/ReceiveVoiceNote.ts'
import { ResolveVoiceTranscript } from '../../../src/application/use-cases/ResolveVoiceTranscript.ts'
import { VoicePrompts } from '../../../src/application/voice/VoicePrompts.ts'
import {
  encodeVoiceCallback,
  parseVoiceCallback,
} from '../../../src/application/voice/voiceCallbackData.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { createSecretRedactor } from '../../../src/domain/redaction/secretValues.ts'
import type { VoiceTranscript } from '../../../src/domain/voice/VoiceTranscript.ts'
import {
  MAX_TRANSCRIPT_LENGTH,
  MAX_VOICE_BYTES,
  VOICE_TRANSCRIPT_TTL_MS,
} from '../../../src/domain/voice/voiceNote.ts'
import {
  ALICE,
  FakeChatGateway,
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
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4])

class InMemoryVoiceStore implements VoiceTranscriptStore {
  readonly rows = new Map<string, VoiceTranscript>()
  put(t: VoiceTranscript): void {
    this.rows.set(t.id, t)
  }
  update(next: VoiceTranscript, expectedRevision: number): boolean {
    if (this.rows.get(next.id)?.revision !== expectedRevision) return false
    this.rows.set(next.id, next)
    return true
  }
  findById(id: string): VoiceTranscript | undefined {
    return this.rows.get(id)
  }
  listPending(): readonly VoiceTranscript[] {
    return [...this.rows.values()].filter((t) => t.isPending)
  }
}

class FakeTranscriber implements Transcriber {
  availabilityResult: TranscriberAvailability = { ok: true }
  text = 'Run the tests please'
  failWith: Error | undefined
  gate: Promise<void> | undefined
  readonly calls: { dir: string; seconds: number; audio: number[] }[] = []
  constructor(private readonly scratch: FakeAudioScratch) {}
  availability(): TranscriberAvailability {
    return this.availabilityResult
  }
  async transcribe(
    workspace: { dir: string },
    seconds: number,
    signal: AbortSignal,
  ): Promise<RawTranscript> {
    this.calls.push({ dir: workspace.dir, seconds, audio: this.scratch.audioOf(workspace.dir) })
    if (this.gate !== undefined) {
      await Promise.race([
        this.gate,
        new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(new TranscriptionError('cancelled'))),
        ),
      ])
    }
    if (this.failWith !== undefined) throw this.failWith
    return { text: this.text }
  }
}

class FakeAudioScratch implements AudioScratch {
  readonly live = new Map<string, number[]>()
  readonly disposed: string[] = []
  #next = 0
  async create(): Promise<AudioDraft> {
    const dir = `ws-${this.#next++}`
    this.live.set(dir, [])
    return {
      dir,
      write: async (chunk) => void this.live.get(dir)?.push(...chunk),
      close: async () => {},
    }
  }
  async dispose(workspace: { dir: string }): Promise<void> {
    this.live.delete(workspace.dir)
    this.disposed.push(workspace.dir)
  }
  async sweep(): Promise<number> {
    return 0
  }
  audioOf(dir: string): number[] {
    return [...(this.live.get(dir) ?? [])]
  }
}

class FakeSource implements AttachmentSource {
  readonly opened: string[] = []
  bytes: Uint8Array = OGG
  declared: number | undefined
  failWith: Error | undefined
  async open(fileId: string) {
    this.opened.push(fileId)
    if (this.failWith !== undefined) throw this.failWith
    const bytes = this.bytes
    return {
      size: this.declared,
      chunks: (async function* () {
        yield bytes
      })(),
    }
  }
}

function harness(options: { maxLength?: number } = {}) {
  const clock = new FakeClock()
  const store = new InMemoryVoiceStore()
  const gateway = new FakePromptGateway()
  const logger = new MemoryLogger()
  const audit = new InMemoryAuditLog()
  const allowed = new InMemoryAllowedSenders()
  allowed.add(allowSender(ALICE, clock.now()))
  const brake = new InMemoryBrakeFlag()
  const prompts = new VoicePrompts(
    new RedactingPromptGateway(gateway, createSecretRedactor([SECRET]), options.maxLength ?? 4096),
    en,
    logger,
  )
  const scratch = new FakeAudioScratch()
  const transcriber = new FakeTranscriber(scratch)
  const source = new FakeSource()
  const chat = new FakeChatGateway()
  const delivered: InboundMessage[] = []
  const common = { store, prompts, audit, clock, logger, session: 'me' }
  const receive = new ReceiveVoiceNote({
    ...common,
    transcriber,
    scratch,
    source,
    chat,
    messages: en,
    random: new SequentialRandom(),
    maxBytes: MAX_VOICE_BYTES,
  })
  const resolve = new ResolveVoiceTranscript({
    ...common,
    deliver: async (message) => void delivered.push(message),
    authorize: new AuthorizeSender(allowed),
    brake,
  })
  const expire = new ExpireVoiceTranscripts(common)
  const note = (overrides: Partial<VoiceMessage['voice']> = {}): VoiceMessage => ({
    chatId: ALICE.id,
    messageId: '10',
    chatKind: 'private',
    sender: ALICE,
    text: undefined,
    sentAt: clock.now(),
    voice: { fileId: 'voice-1', duration: 4, size: OGG.length, ...overrides },
  })
  const settle = async () => {
    for (let i = 0; i < 50 && receive.pending > 0; i++) await Bun.sleep(1)
    await Bun.sleep(1)
  }
  const tap = (transcriptId: string, action: 'send' | 'discard', overrides = {}) =>
    resolve.execute({
      transcriptId,
      action,
      sender: ALICE,
      chatId: ALICE.id,
      messageId: '500',
      ...overrides,
    })
  const only = () => {
    const [t] = store.rows.values()
    if (t === undefined) throw new Error('no transcript')
    return t
  }
  return {
    clock,
    store,
    gateway,
    logger,
    audit,
    brake,
    scratch,
    transcriber,
    source,
    chat,
    delivered,
    receive,
    resolve,
    expire,
    note,
    settle,
    tap,
    only,
  }
}

const events = (audit: InMemoryAuditLog) => audit.entries.map((e) => e.event)
const reasonOf = (e: { details: unknown } | undefined) =>
  (e?.details as { reason?: unknown } | undefined)?.reason

describe('voice callback data', () => {
  test('round trip, strict and anchored', () => {
    expect(encodeVoiceCallback('abcdefghij', 'send')).toBe('v1:abcdefghij:s')
    expect(parseVoiceCallback('v1:abcdefghij:d')).toEqual({
      transcriptId: 'abcdefghij',
      action: 'discard',
    })
    for (const bad of [
      'v1:abcdefghij:x',
      'v1:abcdefghij:s ',
      ' v1:abcdefghij:s',
      'v1:ABCDEFGHIJ:s',
      'v2:abcdefghij:s',
      'm1:abcdefghij:a',
      'p1:abcde:a',
      undefined,
    ]) {
      expect(parseVoiceCallback(bad)).toBeUndefined()
    }
    expect(() => encodeVoiceCallback('nope', 'send')).toThrow()
  })
})

describe('ReceiveVoiceNote', () => {
  test('happy path: downloads, transcribes, deletes the audio, shows Send/Discard', async () => {
    const h = harness()
    h.receive.start(h.note())
    await h.settle()
    expect(h.transcriber.calls).toEqual([{ dir: 'ws-0', seconds: 4, audio: [...OGG] }])
    expect(h.scratch.disposed).toEqual(['ws-0'])
    expect(h.scratch.live.size).toBe(0)
    const prompt = h.gateway.sent[0]
    expect(prompt?.text).toContain('Run the tests please')
    const t = h.only()
    expect(t.state).toBe('pending')
    expect(t.prompt).toEqual({ chatId: ALICE.id, messageId: '500' })
    expect(prompt?.keyboard.flat().map((b) => b.data)).toEqual([`v1:${t.id}:s`, `v1:${t.id}:d`])
    const row = h.audit.entries.find((e) => e.event === 'voice.transcribed')
    expect(row?.details).toMatchObject({
      transcriptId: t.id,
      declaredSeconds: 4,
      bytes: OGG.length,
      characters: 20,
    })
    // Never the transcript in the audit or the log.
    expect(JSON.stringify(h.audit.entries)).not.toContain('Run the tests')
    expect(h.logger.text).not.toContain('Run the tests')
    expect(h.delivered).toEqual([])
  })

  test('not configured: one help reply per window, nothing downloaded', async () => {
    const h = harness()
    h.transcriber.availabilityResult = { ok: false, reason: 'not_configured' }
    h.receive.start(h.note())
    h.receive.start(h.note())
    await h.settle()
    expect(h.source.opened).toEqual([])
    expect(h.chat.sent.map((s) => s.text)).toEqual([en.voiceUnavailable('not_configured')])
    expect(events(h.audit)).toEqual(['voice.refused', 'voice.refused'])
  })

  test('too long or too large is refused before downloading', async () => {
    const h = harness()
    h.receive.start(h.note({ duration: 181 }))
    h.receive.start(h.note({ duration: undefined }))
    h.receive.start(h.note({ size: MAX_VOICE_BYTES + 1 }))
    await h.settle()
    expect(h.source.opened).toEqual([])
    expect(h.audit.entries.map((e) => reasonOf(e))).toEqual(['too_long', 'too_long', 'too_large'])
  })

  test('the size cap applies to the bytes received, whatever was declared', async () => {
    const h = harness()
    h.source.bytes = new Uint8Array(MAX_VOICE_BYTES + 1).fill(0x4f)
    h.source.bytes.set(OGG.subarray(0, 4))
    h.receive.start(h.note({ size: undefined }))
    await h.settle()
    expect(h.transcriber.calls).toEqual([])
    expect(h.scratch.live.size).toBe(0)
    expect(reasonOf(h.audit.entries[0])).toBe('too_large')
  })

  test('content that is not Ogg is refused and deleted, never transcribed', async () => {
    const h = harness()
    h.source.bytes = new TextEncoder().encode('ID3\u0003 not ogg at all')
    h.receive.start(h.note())
    await h.settle()
    expect(h.transcriber.calls).toEqual([])
    expect(h.scratch.live.size).toBe(0)
    expect(h.chat.sent[0]?.text).toBe(
      en.voiceRefused({ reason: 'not_ogg', maxSeconds: 180, maxMegabytes: 2 }),
    )
  })

  test('a failed transcription deletes the audio and says why', async () => {
    const h = harness()
    h.transcriber.failWith = new TranscriptionError('timeout')
    h.receive.start(h.note())
    await h.settle()
    expect(h.scratch.live.size).toBe(0)
    expect(h.store.rows.size).toBe(0)
    expect(reasonOf(h.audit.entries[0])).toBe('timeout')
  })

  test('nothing heard, or a transcript too long for one message: refused, never cut', async () => {
    const h = harness()
    h.transcriber.text = '[BLANK_AUDIO]\n'
    h.receive.start(h.note())
    await h.settle()
    h.transcriber.text = 'a'.repeat(MAX_TRANSCRIPT_LENGTH + 1)
    h.receive.start(h.note())
    await h.settle()
    expect(h.audit.entries.map((e) => reasonOf(e))).toEqual(['nothing_heard', 'text_too_long'])
    expect(h.gateway.sent).toEqual([])
  })

  test('a transcript redaction would change is never offered (what is sent is what is shown)', async () => {
    const h = harness()
    h.transcriber.text = `the password is ${SECRET}`
    h.receive.start(h.note())
    await h.settle()
    expect(h.gateway.sent).toEqual([])
    expect(h.only().state).toBe('cancelled')
    expect(reasonOf(h.audit.entries[0])).toBe('contains_secret')
    expect(JSON.stringify(h.audit.entries)).not.toContain(SECRET)
  })

  test('a prompt that does not fit one message is refused', async () => {
    const h = harness({ maxLength: 100 })
    h.transcriber.text = 'word '.repeat(40)
    h.receive.start(h.note())
    await h.settle()
    expect(h.gateway.sent).toEqual([])
    expect(reasonOf(h.audit.entries[0])).toBe('text_too_long')
  })

  test('one at a time, a short queue, then busy; stop cancels and cleans up', async () => {
    const h = harness()
    let release = () => {}
    h.transcriber.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++) h.receive.start(h.note())
    await Bun.sleep(5)
    expect(h.transcriber.calls).toHaveLength(1)
    expect(h.receive.pending).toBe(3)
    expect(h.audit.entries.map((e) => reasonOf(e))).toEqual(['busy'])
    await h.receive.stop()
    expect(h.scratch.live.size).toBe(0)
    expect(h.receive.pending).toBe(0)
    release()
    h.receive.start(h.note())
    expect(h.receive.pending).toBe(0)
  })
})

describe('ResolveVoiceTranscript', () => {
  async function shown(h: ReturnType<typeof harness>) {
    h.receive.start(h.note())
    await h.settle()
    return h.only().id
  }

  test('Send delivers exactly the shown text once, as voice, and removes the buttons', async () => {
    const h = harness()
    const id = await shown(h)
    expect(await h.tap(id, 'send')).toBe('sent')
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toMatchObject({
      chatId: ALICE.id,
      chatKind: 'private',
      sender: ALICE,
      text: 'Run the tests please',
      forwardContext: { kind: 'voice', transcriptId: id },
    })
    expect(h.gateway.edits.at(-1)?.keyboard).toEqual([])
    expect(h.gateway.edits.at(-1)?.text).toContain('Sent to Claude')
    expect(await h.tap(id, 'send')).toBe('already_resolved')
    expect(await h.tap(id, 'discard')).toBe('already_resolved')
    expect(h.delivered).toHaveLength(1)
    expect(h.audit.entries.find((e) => e.event === 'voice.sent')?.details).toEqual({
      transcriptId: id,
      characters: 20,
    })
  })

  test('Discard sends nothing', async () => {
    const h = harness()
    const id = await shown(h)
    expect(await h.tap(id, 'discard')).toBe('discarded')
    expect(h.delivered).toEqual([])
    expect(h.gateway.edits.at(-1)?.keyboard).toEqual([])
    expect(await h.tap(id, 'send')).toBe('already_resolved')
  })

  test('braked: Send changes nothing and can be tapped again after /resume', async () => {
    const h = harness()
    const id = await shown(h)
    h.brake.engage({ engagedAt: 0, by: 'cli', reason: undefined } as never)
    expect(await h.tap(id, 'send')).toBe('braked')
    expect(h.delivered).toEqual([])
    expect(h.only().state).toBe('pending')
    h.brake.release()
    expect(await h.tap(id, 'send')).toBe('sent')
  })

  test('expired after the TTL: a late tap sends nothing', async () => {
    const h = harness()
    const id = await shown(h)
    h.clock.advance(VOICE_TRANSCRIPT_TTL_MS)
    expect(await h.tap(id, 'send')).toBe('expired')
    expect(h.delivered).toEqual([])
    expect(h.gateway.edits.at(-1)?.keyboard).toEqual([])
  })

  test('other chats, other sessions, strangers and races', async () => {
    const h = harness()
    const id = await shown(h)
    expect(await h.tap(id, 'send', { sender: MALLORY, chatId: MALLORY.id })).toBe('not_allowed')
    expect(await h.tap(id, 'send', { chatId: '999' })).toBe('not_found')
    expect(await h.tap('zzzzzzzzzz', 'send')).toBe('not_found')
    // A racing writer (the expiry timer) wins: the tap sees the new state.
    const stored = h.only()
    h.store.update(stored.expire(h.clock.now()), stored.revision)
    expect(await h.tap(id, 'send')).toBe('expired')
    expect(h.delivered).toEqual([])
  })

  test('the sweep expires due transcripts and cancels orphans; nothing is sent', async () => {
    const h = harness()
    const id = await shown(h)
    expect(await h.expire.execute()).toBe(0)
    h.clock.advance(VOICE_TRANSCRIPT_TTL_MS)
    expect(await h.expire.execute()).toBe(1)
    expect(h.store.findById(id)?.state).toBe('expired')
    expect(h.gateway.edits.at(-1)?.keyboard).toEqual([])
    const other = new ExpireVoiceTranscripts({
      store: h.store,
      prompts: new VoicePrompts(h.gateway, en, h.logger),
      audit: h.audit,
      clock: h.clock,
      logger: h.logger,
      session: 'another',
    })
    h.receive.start(h.note())
    await h.settle()
    expect(await other.expireOrphans()).toBe(1)
    expect(h.store.listPending()).toEqual([])
    expect(h.delivered).toEqual([])
  })
})

describe('the pipeline pieces', () => {
  test('VoiceNoteStep hands voice notes off and passes everything else on', async () => {
    const started: VoiceMessage[] = []
    const passed: InboundMessage[] = []
    const step = new VoiceNoteStep({ start: (m) => void started.push(m) })
    const base: InboundMessage = {
      chatId: ALICE.id,
      messageId: '1',
      chatKind: 'private',
      sender: ALICE,
      text: undefined,
      sentAt: 0,
    }
    await step.handle(
      { ...base, voice: { fileId: 'f', duration: 1, size: 1 } },
      async (m) => void passed.push(m),
    )
    await step.handle({ ...base, text: 'hi' }, async (m) => void passed.push(m))
    expect(started).toHaveLength(1)
    expect(passed.map((m) => m.text)).toEqual(['hi'])
  })

  test('a confirmed transcript may answer a waiting "Other..." choice, keeping its id', async () => {
    const out: InboundMessage[] = []
    const step = new ChoiceTextAnswerStep({ execute: async () => 'choiceid22' })
    const message: InboundMessage = {
      chatId: ALICE.id,
      messageId: '1',
      chatKind: 'private',
      sender: ALICE,
      text: 'MariaDB',
      sentAt: 0,
      forwardContext: { kind: 'voice', transcriptId: 'abcdefghij' },
    }
    await step.handle(message, async (m) => void out.push(m))
    expect(out[0]?.forwardContext).toEqual({
      kind: 'choice',
      choiceId: 'choiceid22',
      transcriptId: 'abcdefghij',
    })
    // Other contexts (an attachment, a memory outcome) still never answer a choice.
    out.length = 0
    await step.handle(
      { ...message, forwardContext: { kind: 'memory', proposalId: 'abcdefghij' } },
      async (m) => void out.push(m),
    )
    expect(out[0]?.forwardContext?.kind).toBe('memory')
  })

  test('ButtonTapHandler routes v1: only to the voice use case, never to a permission', async () => {
    const clock = new FakeClock()
    const allowed = new InMemoryAllowedSenders()
    allowed.add(allowSender(ALICE, clock.now()))
    const voiceCalls: unknown[] = []
    let permissionCalls = 0
    const prompts = new FakePromptGateway()
    const handler = new ButtonTapHandler({
      authorize: new AuthorizeSender(allowed),
      resolve: {
        execute: async () => {
          permissionCalls += 1
          return 'approved'
        },
      } as never,
      voice: {
        execute: async (input) => {
          voiceCalls.push(input)
          return 'sent'
        },
      },
      prompts,
      messages: en,
      clock,
      logger: new MemoryLogger(),
    })
    await handler.handle({
      id: 'cb1',
      chatId: ALICE.id,
      chatKind: 'private',
      messageId: '5',
      sender: ALICE,
      data: 'v1:abcdefghij:s',
    })
    expect(voiceCalls).toEqual([
      {
        transcriptId: 'abcdefghij',
        action: 'send',
        sender: ALICE,
        chatId: ALICE.id,
        messageId: '5',
      },
    ])
    expect(prompts.answers).toEqual([{ callbackId: 'cb1', text: en.voiceFeedback('sent') }])
    await handler.handle({
      id: 'cb2',
      chatId: ALICE.id,
      chatKind: 'private',
      messageId: '5',
      sender: ALICE,
      data: 'v1:abcde:s',
    })
    expect(permissionCalls).toBe(0)
    expect(voiceCalls).toHaveLength(1)
  })
})

describe('the transcript chain and the notice for voice', () => {
  const base: InboundMessage = {
    chatId: ALICE.id,
    messageId: '1',
    chatKind: 'private',
    sender: ALICE,
    text: undefined,
    sentAt: 0,
  }

  test('voice notes pass the unsupported-content step only when F13 is wired', async () => {
    const voiceNote = { ...base, voice: { fileId: 'f', duration: 1, size: 1 } }
    let passed = 0
    const next = async () => {
      passed += 1
    }
    const chat = new FakeChatGateway()
    const args = [chat, en.onlyTextSupported, new FakeClock(), new MemoryLogger()] as const
    await new UnsupportedContentStep(...args, false, true).handle(voiceNote, next)
    expect(passed).toBe(1)
    await new UnsupportedContentStep(...args, true, false).handle(voiceNote, next)
    expect(passed).toBe(1)
    expect(chat.sent.map((s) => s.text)).toEqual([en.onlyTextSupported])
  })

  test('a transcript reading "/stop" or a verdict is delivered as text, never routed', async () => {
    const forwarded: InboundMessage[] = []
    const steps = createTranscriptSteps({
      chat: new FakeChatGateway(),
      messages: en,
      logger: new MemoryLogger(),
      clock: new FakeClock(),
      audit: new InMemoryAuditLog(),
      forward: { execute: async (m: InboundMessage) => void forwarded.push(m) } as never,
      brake: new InMemoryBrakeFlag(),
    })
    expect(steps.some((s) => s instanceof CommandRouterStep)).toBe(false)
    expect(steps.some((s) => s instanceof PermissionVerdictStep)).toBe(false)
    const chain = buildPipeline(steps)
    for (const text of ['/stop', '/pair', 'yes abcde']) {
      await chain({ ...base, text, forwardContext: { kind: 'voice', transcriptId: 'abcdefghij' } })
    }
    expect(forwarded.map((m) => m.text)).toEqual(['/stop', '/pair', 'yes abcde'])
  })
})
