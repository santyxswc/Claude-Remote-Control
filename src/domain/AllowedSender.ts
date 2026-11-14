import type { SenderProfile } from './Sender.ts'

/** A sender the owner confirmed at the terminal; the only one whose messages go through. */
export interface AllowedSender extends SenderProfile {
  /** Epoch milliseconds. */
  readonly addedAt: number
}

export function allowSender(profile: SenderProfile, now: number): AllowedSender {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    addedAt: now,
  }
}
