/**
 * What an incoming voice note may be, and how long its transcription may
 * take (F13). Pure: the use case feeds it Telegram's declared metadata and
 * the first bytes of the download.
 */

/**
 * Longest voice note accepted, in seconds. Telegram reports the duration "as
 * defined by the sender", so it is checked before downloading and enforced
 * again by the converter, which reads at most this much audio (plus a second).
 * Three minutes of speech is about 450 words, which still fits the transcript
 * in one Telegram message with its header (see `MAX_TRANSCRIPT_LENGTH`).
 */
export const MAX_VOICE_SECONDS = 180

/**
 * Largest voice note downloaded, in bytes. Telegram voice notes are Opus at a
 * low bitrate (tens of kbit/s), so three minutes is well under 1 MB; 2 MB
 * leaves room for a high-bitrate client and stays far below the 20 MB Bot API
 * download limit.
 */
export const MAX_VOICE_BYTES = 2_000_000

/**
 * Longest transcript offered for sending, in code points. It must fit one
 * message with the header and the hint (Telegram: 4,096), because what Send
 * delivers is exactly what was shown. Longer transcripts are refused, never cut.
 */
export const MAX_TRANSCRIPT_LENGTH = 3_500

/** An unanswered transcript expires after this long: Send is a decision made now. */
export const VOICE_TRANSCRIPT_TTL_MS = 10 * 60_000

/** One transcription runs at a time; at most this many more wait, the rest get "busy". */
export const MAX_VOICE_QUEUE = 2

/** The conversion of a three-minute note takes well under a second; this is generous. */
export const VOICE_CONVERSION_TIMEOUT_MS = 30_000

/** The converter reads at most this many seconds of audio, whatever the note declares. */
export const MAX_DECODED_SECONDS = MAX_VOICE_SECONDS + 1

/** 16 kHz, mono, 16-bit PCM: 32,000 bytes per second, plus a header. */
export const MAX_WAV_BYTES = MAX_DECODED_SECONDS * 32_000 + 4_096

const BASE_TRANSCRIPTION_MS = 60_000
const PER_AUDIO_SECOND_MS = 3_000
const MAX_TRANSCRIPTION_MS = 10 * 60_000

/**
 * The deadline for whisper.cpp, scaled by the note's length: a minute to load
 * the model plus three seconds per second of audio (a large model on a slow
 * CPU runs at about real time; small models run many times faster), at most
 * ten minutes. Then the process is killed.
 */
export function transcriptionTimeoutMs(durationSeconds: number): number {
  const seconds = Number.isFinite(durationSeconds)
    ? Math.min(Math.max(durationSeconds, 0), MAX_DECODED_SECONDS)
    : MAX_DECODED_SECONDS
  return Math.min(
    BASE_TRANSCRIPTION_MS + Math.ceil(seconds) * PER_AUDIO_SECOND_MS,
    MAX_TRANSCRIPTION_MS,
  )
}

export type VoiceNoteProblem = 'too_long' | 'too_large' | 'empty'

/**
 * Before downloading: the declared duration must be a known number of seconds
 * within the cap, and the declared size, when there is one, within `maxBytes`.
 */
export function checkVoiceNote(
  note: { readonly duration: number | undefined; readonly size: number | undefined },
  maxBytes: number,
): VoiceNoteProblem | undefined {
  const { duration, size } = note
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) return 'too_long'
  if (duration > MAX_VOICE_SECONDS) return 'too_long'
  if (size !== undefined) {
    if (size > maxBytes) return 'too_large'
    if (size === 0) return 'empty'
  }
  return undefined
}

/** Bytes of the head needed to recognize the container. */
export const VOICE_SNIFF_BYTES = 4

/** Every Ogg page starts with the capture pattern `OggS` (RFC 3533, section 6). */
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53] as const

/** True when the first bytes are an Ogg page: Telegram voice notes are Opus in Ogg. */
export function isOggHead(head: Uint8Array): boolean {
  return OGG_MAGIC.every((byte, index) => head[index] === byte)
}
