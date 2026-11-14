import type { VoiceTranscript } from '../../domain/voice/VoiceTranscript.ts'

/**
 * Persists voice transcripts waiting for Send or Discard (F13). Writers race
 * (a tap, the expiry timer), so `update` is a compare-and-set.
 */
export interface VoiceTranscriptStore {
  put(transcript: VoiceTranscript): void
  /** Stores `next` only if the stored revision is still `expectedRevision`. */
  update(next: VoiceTranscript, expectedRevision: number): boolean
  findById(id: string): VoiceTranscript | undefined
  /** Pending transcripts of every session, oldest first. */
  listPending(): readonly VoiceTranscript[]
}
