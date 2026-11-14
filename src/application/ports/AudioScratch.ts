/** A private directory holding one voice note while it is transcribed (F13). */
export interface AudioWorkspace {
  /** Absolute; the transcriber runs its programs here. */
  readonly dir: string
}

/** The workspace while the voice note is written into it. */
export interface AudioDraft extends AudioWorkspace {
  write(chunk: Uint8Array): Promise<void>
  /** Closes the audio file; call before transcribing. */
  close(): Promise<void>
}

/**
 * Private temporary space for voice notes: a fresh directory per note with a
 * name we generate, readable only by us, removed with everything in it as
 * soon as the transcription ends. Audio is never kept.
 */
export interface AudioScratch {
  create(): Promise<AudioDraft>
  /** Never rejects; closes the file and removes the directory and everything in it. */
  dispose(workspace: AudioWorkspace): Promise<void>
  /** Removes workspaces a crashed process left behind; returns how many. Never rejects. */
  sweep(): Promise<number>
}
