import type { InboxEntry } from '../../domain/attachments/inboxRetention.ts'

/** A file being written into the inbox; invisible under its final name until `keep`. */
export interface InboxDraft {
  write(chunk: Uint8Array): Promise<void>
  /** Closes it under its final name (owner-only, never executable); returns the absolute path. */
  keep(): Promise<string>
  /** Removes whatever was written. Never rejects. */
  discard(): Promise<void>
}

/**
 * This session's private folder for incoming files (F10). File names are
 * always generated here (random id + the given extension); nothing a sender
 * chose ever becomes part of a path.
 */
export interface AttachmentInbox {
  /** `extension` comes from the allowlist (letters and digits only). */
  draft(extension: string): Promise<InboxDraft>
  list(): Promise<readonly InboxEntry[]>
  /** Removes files of this session's inbox by the names `list` gave. Never rejects. */
  remove(names: readonly string[]): Promise<number>
  /**
   * Removes the inboxes of every other session (ADR 0007: they belong to the
   * poller), or only of the sessions in only (F14: ended sessions of this topic).
   */
  removeOtherSessions(only?: ReadonlySet<string>): Promise<number>
}
