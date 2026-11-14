import { TranscriptionError } from '../../application/errors.ts'
import type {
  RawTranscript,
  Transcriber,
  TranscriberAvailability,
  TranscriberUnavailable,
} from '../../application/ports/Transcriber.ts'
import type { SystemProbe } from '../capture/systemProbe.ts'
import type { CapturingProcessRunner } from '../session/processRunner.ts'
import type { VoiceSetup } from './voiceSetup.ts'
import { WhisperCppTranscriber } from './WhisperCppTranscriber.ts'

/** Voice notes are off or misconfigured: every note gets the reason, nothing runs. */
export class UnavailableTranscriber implements Transcriber {
  constructor(private readonly reason: TranscriberUnavailable) {}

  availability(): TranscriberAvailability {
    return { ok: false, reason: this.reason }
  }

  async transcribe(): Promise<RawTranscript> {
    throw new TranscriptionError('transcription_failed')
  }
}

export interface TranscriberContext {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly run: CapturingProcessRunner
  readonly probe: Pick<SystemProbe, 'isFile'>
}

/** The transcriber the setup allows: whisper.cpp with ffmpeg, or one that says why not. */
export function createTranscriber(setup: VoiceSetup, context: TranscriberContext): Transcriber {
  if (!setup.ok) return new UnavailableTranscriber(setup.reason)
  return new WhisperCppTranscriber({
    whisper: [setup.whisper],
    ffmpeg: [setup.ffmpeg],
    model: setup.model,
    language: setup.language,
    env: context.env,
    run: context.run,
    probe: context.probe,
  })
}
