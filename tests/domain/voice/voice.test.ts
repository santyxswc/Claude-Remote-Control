import { describe, expect, test } from 'bun:test'
import { DomainError } from '../../../src/domain/DomainError.ts'
import { cleanTranscript, transcriptLength } from '../../../src/domain/voice/transcriptText.ts'
import {
  InvalidVoiceTranscriptTransitionError,
  VoiceTranscript,
} from '../../../src/domain/voice/VoiceTranscript.ts'
import {
  checkVoiceNote,
  isOggHead,
  MAX_DECODED_SECONDS,
  MAX_TRANSCRIPT_LENGTH,
  MAX_VOICE_BYTES,
  MAX_VOICE_SECONDS,
  MAX_WAV_BYTES,
  transcriptionTimeoutMs,
  VOICE_TRANSCRIPT_TTL_MS,
} from '../../../src/domain/voice/voiceNote.ts'

describe('voice note limits', () => {
  test('the values the docs promise', () => {
    expect(MAX_VOICE_SECONDS).toBe(180)
    expect(MAX_VOICE_BYTES).toBe(2_000_000)
    expect(MAX_TRANSCRIPT_LENGTH).toBe(3_500)
    expect(VOICE_TRANSCRIPT_TTL_MS).toBe(600_000)
    expect(MAX_DECODED_SECONDS).toBe(181)
    // A full-length note at 16 kHz mono 16-bit fits the WAV cap.
    expect(MAX_WAV_BYTES).toBeGreaterThan(MAX_DECODED_SECONDS * 16_000 * 2 + 44)
    // The transcript plus header and hint fit one Telegram message.
    expect(MAX_TRANSCRIPT_LENGTH + 400).toBeLessThan(4_096)
  })

  test('checkVoiceNote: duration known and within the cap, declared size within the cap', () => {
    expect(checkVoiceNote({ duration: 5, size: 10_000 }, MAX_VOICE_BYTES)).toBeUndefined()
    expect(checkVoiceNote({ duration: 180, size: undefined }, MAX_VOICE_BYTES)).toBeUndefined()
    expect(checkVoiceNote({ duration: 181, size: 1 }, MAX_VOICE_BYTES)).toBe('too_long')
    for (const duration of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkVoiceNote({ duration, size: 1 }, MAX_VOICE_BYTES)).toBe('too_long')
    }
    expect(checkVoiceNote({ duration: 1, size: MAX_VOICE_BYTES + 1 }, MAX_VOICE_BYTES)).toBe(
      'too_large',
    )
    expect(checkVoiceNote({ duration: 1, size: 0 }, MAX_VOICE_BYTES)).toBe('empty')
  })

  test('the Ogg capture pattern', () => {
    expect(isOggHead(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0]))).toBe(true)
    expect(isOggHead(new TextEncoder().encode('ID3\u0003'))).toBe(false)
    expect(isOggHead(new TextEncoder().encode('RIFF'))).toBe(false)
    expect(isOggHead(new Uint8Array([0x4f, 0x67, 0x67]))).toBe(false)
  })

  test('the transcription deadline scales with the duration and is bounded', () => {
    expect(transcriptionTimeoutMs(0)).toBe(60_000)
    expect(transcriptionTimeoutMs(10)).toBe(90_000)
    expect(transcriptionTimeoutMs(180)).toBe(600_000)
    expect(transcriptionTimeoutMs(100_000)).toBe(600_000)
    expect(transcriptionTimeoutMs(Number.NaN)).toBe(600_000)
    expect(transcriptionTimeoutMs(-5)).toBe(60_000)
  })
})

describe('cleanTranscript', () => {
  test('segments joined, whitespace collapsed', () => {
    expect(cleanTranscript(' Hola,\n  ¿cómo estás?\r\n\nBien.\n')).toBe('Hola, ¿cómo estás? Bien.')
  })

  test('timestamps and the silence marker are stripped', () => {
    expect(
      cleanTranscript(
        '[00:00:00.000 --> 00:00:02.500]  Uno\n[00:02.500 --> 00:04,000] dos\n[BLANK_AUDIO]\n',
      ),
    ).toBe('Uno dos')
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('')
    // Brackets that are not timestamps are speech the owner should see.
    expect(cleanTranscript('[Música] hola')).toBe('[Música] hola')
  })

  test('controls, escape sequences, bidi overrides and invisible characters are removed', () => {
    expect(cleanTranscript('a\u001b[31mb‮c​d\u0000e')).toBe('a [31mbcd e')
  })

  test('never cut: the caller decides', () => {
    const long = 'palabra '.repeat(1_000)
    expect(transcriptLength(cleanTranscript(long))).toBe(long.trim().length)
    expect(transcriptLength('ñ😀')).toBe(2)
  })
})

describe('VoiceTranscript', () => {
  const open = () =>
    VoiceTranscript.open({
      id: 'abcdefghij',
      session: 's',
      chatId: '42',
      text: 'hola',
      durationSeconds: 4.4,
      now: 1_000,
    })

  test('opens pending with its length and a whole duration', () => {
    const t = open()
    expect(t.state).toBe('pending')
    expect(t.length).toBe(4)
    expect(t.durationSeconds).toBe(4)
    expect(t.revision).toBe(0)
    expect(() => VoiceTranscript.open({ ...t.toSnapshot(), id: 'BAD', now: 1 })).toThrow(
      DomainError,
    )
    expect(() => VoiceTranscript.open({ ...t.toSnapshot(), text: '  ', now: 1 })).toThrow(
      DomainError,
    )
  })

  test('pending -> sent | discarded | expired | cancelled, each final; revisions bump', () => {
    const t = open()
    const sent = t.send('7', 2_000)
    expect(sent).toMatchObject({ state: 'sent', resolvedBy: '7', closedAt: 2_000, revision: 1 })
    expect(t.discard('7', 2_000).state).toBe('discarded')
    expect(t.expire(2_000).state).toBe('expired')
    expect(t.cancel(2_000).state).toBe('cancelled')
    for (const closed of [sent, t.discard('7', 1), t.expire(1), t.cancel(1)]) {
      expect(() => closed.send('7', 3)).toThrow(InvalidVoiceTranscriptTransitionError)
      expect(() => closed.discard('7', 3)).toThrow(InvalidVoiceTranscriptTransitionError)
      expect(() => closed.expire(3)).toThrow(InvalidVoiceTranscriptTransitionError)
    }
    expect(t.withPrompt({ chatId: '42', messageId: '9' })).toMatchObject({
      state: 'pending',
      revision: 1,
    })
  })

  test('due after the TTL, only while pending', () => {
    const t = open()
    expect(t.isDue(1_000 + VOICE_TRANSCRIPT_TTL_MS - 1)).toBe(false)
    expect(t.isDue(1_000 + VOICE_TRANSCRIPT_TTL_MS)).toBe(true)
    expect(t.send('7', 2).isDue(1_000 + VOICE_TRANSCRIPT_TTL_MS)).toBe(false)
  })
})
