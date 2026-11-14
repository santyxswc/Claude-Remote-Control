import { EventThrottle } from '../../domain/EventThrottle.ts'
import { UNSUPPORTED_NOTICE_WINDOW_MS } from '../../domain/inboundLimits.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import { cleanTranscript, transcriptLength } from '../../domain/voice/transcriptText.ts'
import { VoiceTranscript, voiceTranscriptIdFrom } from '../../domain/voice/VoiceTranscript.ts'
import {
  checkVoiceNote,
  isOggHead,
  MAX_TRANSCRIPT_LENGTH,
  MAX_VOICE_QUEUE,
  MAX_VOICE_SECONDS,
  VOICE_SNIFF_BYTES,
} from '../../domain/voice/voiceNote.ts'
import { PromptRedactedError, PromptTooLongError, TranscriptionError } from '../errors.ts'
import type { Messages, VoiceRefusalReason } from '../i18n/messages.ts'
import type { InboundMessage, InboundVoice } from '../pipeline/InboundMessage.ts'
import type { AttachmentSource } from '../ports/AttachmentSource.ts'
import type { AudioDraft, AudioScratch } from '../ports/AudioScratch.ts'
import type { AuditDetails, AuditLog } from '../ports/AuditLog.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { RandomSource } from '../ports/RandomSource.ts'
import type { Transcriber } from '../ports/Transcriber.ts'
import type { VoiceTranscriptStore } from '../ports/VoiceTranscriptStore.ts'
import type { VoicePrompts } from '../voice/VoicePrompts.ts'

/** An authenticated message carrying a voice note. */
export interface VoiceMessage extends InboundMessage {
  readonly sender: SenderProfile
  readonly voice: InboundVoice
}

export interface ReceiveVoiceNoteDeps {
  readonly transcriber: Transcriber
  readonly scratch: AudioScratch
  /** The F10 download path (Telegram `getFile`, token-free errors). */
  readonly source: AttachmentSource
  readonly store: VoiceTranscriptStore
  readonly prompts: VoicePrompts
  /** The decorated outbound gateway, for notices. */
  readonly chat: ChatGateway
  readonly messages: Pick<Messages, 'voiceUnavailable' | 'voiceRefused'>
  readonly random: RandomSource
  /** At most this many bytes per note (`MAX_VOICE_BYTES`, or the upload cap if lower). */
  readonly maxBytes: number
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/** A refusal decided while working; the workspace is removed either way. */
class Refused extends Error {
  constructor(readonly reason: VoiceRefusalReason) {
    super(reason)
  }
}

interface Measured {
  bytes: number | undefined
  transcribeMs: number | undefined
}

/**
 * An incoming voice note (F13). Checked before downloading (transcription
 * available, declared duration and size), then streamed into a private
 * scratch directory with the size cap and the Ogg magic enforced as it
 * streams, transcribed locally, and the directory removed as soon as the
 * transcription ends, success or not: audio is never kept and never reaches
 * the session. The cleaned transcript is shown with Send and Discard; it is
 * never forwarded by itself. One note is transcribed at a time and at most
 * `MAX_VOICE_QUEUE` wait; `start` returns at once and `stop` cancels
 * everything. Audit rows carry durations, sizes, counts and outcomes, never
 * the transcript.
 */
export class ReceiveVoiceNote {
  readonly #queue: VoiceMessage[] = []
  readonly #abort = new AbortController()
  readonly #unavailableNotices = new EventThrottle(UNSUPPORTED_NOTICE_WINDOW_MS)
  #running: Promise<void> | undefined

  constructor(private readonly deps: ReceiveVoiceNoteDeps) {}

  /** Queues the note and returns; refusals and the transcript are reported in the chat. */
  start(message: VoiceMessage): void {
    if (this.#abort.signal.aborted) return
    const availability = this.deps.transcriber.availability()
    if (!availability.ok) {
      this.#audit(message, { reason: availability.reason, ...declared(message.voice) }, 'refused')
      this.deps.logger.info('voice note not transcribed: transcription unavailable', {
        senderId: message.sender.id,
        reason: availability.reason,
      })
      if (this.#unavailableNotices.record(message.sender.id, this.deps.clock.now()).emit) {
        void this.#tell(message.chatId, this.deps.messages.voiceUnavailable(availability.reason))
      }
      return
    }
    const problem = checkVoiceNote(message.voice, this.deps.maxBytes)
    if (problem !== undefined) {
      void this.#refuse(message, problem, { bytes: undefined, transcribeMs: undefined })
      return
    }
    if (this.#queue.length >= MAX_VOICE_QUEUE) {
      void this.#refuse(message, 'busy', { bytes: undefined, transcribeMs: undefined })
      return
    }
    this.#queue.push(message)
    this.#pump()
  }

  /** For shutdown: drops the queue, kills a transcription in flight and waits for its clean-up. */
  async stop(): Promise<void> {
    this.#queue.length = 0
    this.#abort.abort()
    await this.#running
  }

  /** Notes running or waiting, for tests and diagnostics. */
  get pending(): number {
    return (this.#running === undefined ? 0 : 1) + this.#queue.length
  }

  #pump(): void {
    if (this.#running !== undefined) return
    const next = this.#queue.shift()
    if (next === undefined) return
    this.#running = this.#process(next, this.#abort.signal).finally(() => {
      this.#running = undefined
      this.#pump()
    })
  }

  async #process(message: VoiceMessage, signal: AbortSignal): Promise<void> {
    const measured: Measured = { bytes: undefined, transcribeMs: undefined }
    try {
      const raw = await this.#transcribe(message, signal, measured)
      const text = cleanTranscript(raw)
      if (text === '') throw new Refused('nothing_heard')
      if (transcriptLength(text) > MAX_TRANSCRIPT_LENGTH) throw new Refused('text_too_long')
      await this.#offer(message, text, measured)
    } catch (error) {
      if (signal.aborted) {
        this.deps.logger.info('voice note cancelled')
        return
      }
      if (!(error instanceof Refused) && !(error instanceof TranscriptionError)) {
        this.deps.logger.warn('could not transcribe a voice note', { error })
      }
      const reason: VoiceRefusalReason =
        error instanceof Refused
          ? error.reason
          : error instanceof TranscriptionError
            ? error.reason === 'cancelled'
              ? 'transcription_failed'
              : error.reason
            : 'download_failed'
      await this.#refuse(message, reason, measured)
    }
  }

  /** Download, transcribe, and always remove the audio before returning. */
  async #transcribe(message: VoiceMessage, signal: AbortSignal, measured: Measured) {
    const { scratch, transcriber, clock } = this.deps
    void this.deps.chat.sendTyping(message.chatId).catch(() => {})
    const workspace = await scratch.create()
    try {
      measured.bytes = await this.#download(message.voice, workspace, signal)
      const started = clock.now()
      const result = await transcriber.transcribe(workspace, message.voice.duration ?? 0, signal)
      measured.transcribeMs = clock.now() - started
      return result.text
    } finally {
      await scratch.dispose(workspace)
    }
  }

  async #download(voice: InboundVoice, draft: AudioDraft, signal: AbortSignal): Promise<number> {
    const { maxBytes } = this.deps
    const remote = await this.deps.source.open(voice.fileId, signal)
    if (remote.size !== undefined && remote.size > maxBytes) throw new Refused('too_large')
    let bytes = 0
    let head: Uint8Array = new Uint8Array(0)
    let checked = false
    try {
      for await (const chunk of remote.chunks) {
        if (signal.aborted) throw new Error('cancelled')
        bytes += chunk.length
        if (bytes > maxBytes) throw new Refused('too_large')
        if (!checked) {
          head = concat(head, chunk.subarray(0, VOICE_SNIFF_BYTES - head.length))
          if (head.length >= VOICE_SNIFF_BYTES) {
            checked = true
            if (!isOggHead(head)) throw new Refused('not_ogg')
          }
        }
        await draft.write(chunk)
      }
    } finally {
      await draft.close()
    }
    if (bytes === 0) throw new Refused('empty')
    if (!checked) throw new Refused('not_ogg')
    return bytes
  }

  /** Stores the transcript as pending and shows it; refused when it could not be shown exactly. */
  async #offer(message: VoiceMessage, text: string, measured: Measured): Promise<void> {
    const { store, clock } = this.deps
    const transcript = VoiceTranscript.open({
      id: voiceTranscriptIdFrom(this.deps.random.bytes(10)),
      session: this.deps.session,
      chatId: message.chatId,
      text,
      durationSeconds: message.voice.duration ?? 0,
      now: clock.now(),
    })
    store.put(transcript)
    let ref: PromptRef
    try {
      ref = await this.deps.prompts.send(transcript)
    } catch (error) {
      store.update(transcript.cancel(clock.now()), transcript.revision)
      if (error instanceof PromptRedactedError) throw new Refused('contains_secret')
      if (error instanceof PromptTooLongError) throw new Refused('text_too_long')
      this.deps.logger.error('could not show a voice transcript', {
        transcriptId: transcript.id,
        error,
      })
      throw new Refused('not_shown')
    }
    this.#attachPrompt(transcript, ref)
    this.#audit(
      message,
      {
        transcriptId: transcript.id,
        ...declared(message.voice),
        bytes: measured.bytes ?? null,
        transcribeMs: measured.transcribeMs ?? null,
        characters: transcript.length,
      },
      'transcribed',
    )
    this.deps.logger.info('voice note transcribed', {
      transcriptId: transcript.id,
      seconds: transcript.durationSeconds,
      bytes: measured.bytes,
      transcribeMs: measured.transcribeMs,
      characters: transcript.length,
    })
  }

  /** Stores where the buttons are, retrying if a tap changed the transcript in between. */
  #attachPrompt(transcript: VoiceTranscript, ref: PromptRef): void {
    let current: VoiceTranscript | undefined = transcript
    while (current !== undefined) {
      if (this.deps.store.update(current.withPrompt(ref), current.revision)) return
      current = this.deps.store.findById(transcript.id)
    }
  }

  async #refuse(message: VoiceMessage, reason: VoiceRefusalReason, measured: Measured) {
    this.#audit(
      message,
      {
        reason,
        ...declared(message.voice),
        bytes: measured.bytes ?? null,
        transcribeMs: measured.transcribeMs ?? null,
      },
      'refused',
    )
    this.deps.logger.info('voice note refused', { senderId: message.sender.id, reason })
    await this.#tell(
      message.chatId,
      this.deps.messages.voiceRefused({
        reason,
        maxSeconds: MAX_VOICE_SECONDS,
        maxMegabytes: Math.max(1, Math.floor(this.deps.maxBytes / 1_000_000)),
      }),
    )
  }

  async #tell(chatId: string, text: string): Promise<void> {
    try {
      await this.deps.chat.sendText(chatId, text)
    } catch (error) {
      this.deps.logger.warn('could not send a voice note notice', { error })
    }
  }

  #audit(message: VoiceMessage, details: AuditDetails, outcome: 'refused' | 'transcribed'): void {
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: `telegram:${message.sender.id}`,
      event: outcome === 'refused' ? 'voice.refused' : 'voice.transcribed',
      details: { senderId: message.sender.id, ...details },
    })
  }
}

/** What Telegram declared; numbers only. */
function declared(voice: InboundVoice): AuditDetails {
  return {
    declaredSeconds: voice.duration ?? null,
    declaredBytes: voice.size ?? null,
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}
