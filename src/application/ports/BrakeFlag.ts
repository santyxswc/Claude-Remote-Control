import type { BrakeRecord } from '../../domain/brake/BrakeRecord.ts'

/**
 * `record` is undefined when the flag exists but cannot be read or parsed:
 * that still counts as engaged (someone asked to stop).
 */
export type BrakeStatus =
  | { readonly engaged: false }
  | { readonly engaged: true; readonly record: BrakeRecord | undefined }

/**
 * The panic brake, shared by every process of the user: the channel, the
 * CLI and the PreToolUse hook (which reads it on its own, without this port).
 */
export interface BrakeFlag {
  /** Writes the flag atomically, replacing any earlier one. */
  engage(record: BrakeRecord): void
  /** Removes the flag; false when there was none. */
  release(): boolean
  status(): BrakeStatus
}
