import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { TranscriptionError } from '../../application/errors.ts'
import type { AudioWorkspace } from '../../application/ports/AudioScratch.ts'
import type {
  RawTranscript,
  Transcriber,
  TranscriberAvailability,
  TranscriberUnavailable,
} from '../../application/ports/Transcriber.ts'
import {
  MAX_DECODED_SECONDS,
  MAX_WAV_BYTES,
  transcriptionTimeoutMs,
  VOICE_CONVERSION_TIMEOUT_MS,
} from '../../domain/voice/voiceNote.ts'
import type { SystemProbe } from '../capture/systemProbe.ts'
import type { CapturedOutput, CapturingProcessRunner } from '../session/processRunner.ts'
import {
  ffmpegArgv,
  TRANSCRIPT_FILE,
  VOICE_WAV_FILE,
  voiceEnvironment,
  whisperArgv,
} from './voiceInvocations.ts'

/** whisper-cli also prints the transcript on stdout; more than this is not a voice note. */
const MAX_STDOUT_BYTES = 256 * 1024
/** The transcript file: a three-minute note is a few kilobytes. */
export const MAX_TRANSCRIPT_FILE_BYTES = 64 * 1024

export interface WhisperCppTranscriberOptions {
  /**
   * The command that starts whisper-cli: its absolute path, resolved once at
   * startup. Tests put a stub script after the Bun executable.
   */
  readonly whisper: readonly string[]
  /** The same for ffmpeg. */
  readonly ffmpeg: readonly string[]
  /** Absolute path of the ggml model file. */
  readonly model: string
  readonly language: string
  /** The channel's environment; only a few variables are passed on (`voiceEnvironment`). */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly run: CapturingProcessRunner
  /** Re-checks the files for every note. */
  readonly probe: Pick<SystemProbe, 'isFile'>
  /** Test seams for the deadlines. */
  readonly conversionTimeoutMs?: number
  readonly transcriptionTimeoutMs?: (durationSeconds: number) => number
}

/**
 * Local speech to text with whisper.cpp (F13, ADR 0016). whisper-cli reads
 * WAV, MP3, FLAC and Ogg Vorbis, but not the Opus a Telegram voice note is,
 * so ffmpeg first converts the note to 16 kHz mono WAV. Both run as fixed,
 * hardened invocations (`voiceInvocations.ts`) in the note's private
 * workspace, with stdin closed, stderr discarded, a scrubbed environment, a
 * capped stdout and a deadline that kills them. The transcript is read from
 * the text file whisper-cli writes, capped; a missing file is a failure even
 * when the exit code is 0 (whisper-cli exits 0 on some argument errors).
 * This is not a sandbox: both are native programs running as the user.
 */
export class WhisperCppTranscriber implements Transcriber {
  constructor(private readonly options: WhisperCppTranscriberOptions) {}

  availability(): TranscriberAvailability {
    const { probe } = this.options
    const missing: TranscriberUnavailable | undefined = !probe.isFile(this.options.model)
      ? 'model_missing'
      : !probe.isFile(this.options.whisper[0] ?? '')
        ? 'whisper_missing'
        : !probe.isFile(this.options.ffmpeg[0] ?? '')
          ? 'ffmpeg_missing'
          : undefined
    return missing === undefined ? { ok: true } : { ok: false, reason: missing }
  }

  async transcribe(
    workspace: AudioWorkspace,
    durationSeconds: number,
    signal: AbortSignal,
  ): Promise<RawTranscript> {
    const env = voiceEnvironment(this.options.env, workspace.dir)
    const converted = await this.#run(
      [
        ...this.options.ffmpeg,
        ...ffmpegArgv({ maxSeconds: MAX_DECODED_SECONDS, maxWavBytes: MAX_WAV_BYTES }),
      ],
      workspace,
      env,
      this.options.conversionTimeoutMs ?? VOICE_CONVERSION_TIMEOUT_MS,
      signal,
    )
    check(converted, signal, 'conversion_failed')
    if (!(await isNonEmptyFile(join(workspace.dir, VOICE_WAV_FILE)))) {
      throw new TranscriptionError('conversion_failed')
    }

    const timeout = (this.options.transcriptionTimeoutMs ?? transcriptionTimeoutMs)(durationSeconds)
    const transcribed = await this.#run(
      [
        ...this.options.whisper,
        ...whisperArgv({ model: this.options.model, language: this.options.language }),
      ],
      workspace,
      env,
      timeout,
      signal,
    )
    check(transcribed, signal, 'transcription_failed')
    return { text: await readTranscript(join(workspace.dir, TRANSCRIPT_FILE)) }
  }

  #run(
    argv: readonly string[],
    workspace: AudioWorkspace,
    env: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<CapturedOutput> {
    return this.options.run(argv, {
      cwd: workspace.dir,
      env,
      timeoutMs,
      maxBytes: MAX_STDOUT_BYTES,
      signal,
    })
  }
}

function check(
  result: CapturedOutput,
  signal: AbortSignal,
  failure: 'conversion_failed' | 'transcription_failed',
): void {
  if (signal.aborted) throw new TranscriptionError('cancelled')
  if (result.timedOut) throw new TranscriptionError('timeout')
  if (result.truncated) throw new TranscriptionError('output_too_large')
  if (result.exitCode !== 0) throw new TranscriptionError(failure)
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/** The transcript file, at most `MAX_TRANSCRIPT_FILE_BYTES`, decoded leniently. */
async function readTranscript(path: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, 'r')
  } catch {
    throw new TranscriptionError('transcription_failed')
  }
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new TranscriptionError('transcription_failed')
    if (info.size > MAX_TRANSCRIPT_FILE_BYTES) throw new TranscriptionError('output_too_large')
    const buffer = new Uint8Array(MAX_TRANSCRIPT_FILE_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_TRANSCRIPT_FILE_BYTES) throw new TranscriptionError('output_too_large')
    // A token split across segments can leave half a UTF-8 character: it becomes U+FFFD.
    return new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}
