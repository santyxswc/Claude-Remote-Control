import type { AudioWorkspace } from './AudioScratch.ts'

/** Why voice notes cannot be transcribed on this machine (F13); the reply says how to fix it. */
export type TranscriberUnavailable =
  /** No model configured: the feature is off (opt-in). */
  | 'not_configured'
  /** The configured model is not an absolute path to a file. */
  | 'model_missing'
  /** No whisper.cpp executable: not on PATH, or the override is not an absolute path to a file. */
  | 'whisper_missing'
  /** No ffmpeg, which converts the voice note (Opus) to the WAV whisper.cpp reads. */
  | 'ffmpeg_missing'

export type TranscriberAvailability =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TranscriberUnavailable }

export interface RawTranscript {
  /** What the transcriber wrote, before cleaning; untrusted text. */
  readonly text: string
}

/**
 * Local speech to text (F13). The audio is the voice note in the workspace
 * the scratch space created; nothing leaves the machine. Rejects with
 * `TranscriptionError`.
 */
export interface Transcriber {
  /** Checked for every voice note: the files may have gone since startup. */
  availability(): TranscriberAvailability
  transcribe(
    workspace: AudioWorkspace,
    durationSeconds: number,
    signal: AbortSignal,
  ): Promise<RawTranscript>
}
