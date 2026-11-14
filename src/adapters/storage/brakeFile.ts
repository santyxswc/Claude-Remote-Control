/**
 * The brake flag on disk: `<stateDir>/brake.json`, 0600, written atomically.
 * The PreToolUse hook reads it on every tool call, so this module imports
 * only node builtins and the import-free domain record.
 *
 * Failure policy (ADR 0003): a missing file is "not braked" (fail open, so a
 * broken install never bricks a session); a file that exists but cannot be
 * read or parsed is "braked" (fail closed, someone asked to stop).
 */
import { closeSync, openSync, readSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BrakeRecord,
  parseBrakeRecord,
  serializeBrakeRecord,
} from '../../domain/brake/BrakeRecord.ts'
import { writeSecretFile } from './stateDir.ts'

export const BRAKE_FILE = 'brake.json'

/** A record is far smaller; a file that fills this buffer is not ours. */
const MAX_BRAKE_FILE_BYTES = 4096

export type BrakeFileState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'engaged'; readonly record: BrakeRecord }
  | { readonly kind: 'unreadable' }

export function brakeFilePath(stateDir: string): string {
  return join(stateDir, BRAKE_FILE)
}

/** Never throws: one open and one read when the flag exists, one failed open otherwise. */
export function readBrakeFile(stateDir: string): BrakeFileState {
  let fd: number
  try {
    fd = openSync(brakeFilePath(stateDir), 'r')
  } catch (error) {
    return isMissing(error) ? { kind: 'absent' } : { kind: 'unreadable' }
  }
  try {
    const buffer = Buffer.alloc(MAX_BRAKE_FILE_BYTES)
    const length = readSync(fd, buffer, 0, MAX_BRAKE_FILE_BYTES, 0)
    if (length >= MAX_BRAKE_FILE_BYTES) return { kind: 'unreadable' }
    const record = parseBrakeRecord(buffer.toString('utf8', 0, length))
    return record === undefined ? { kind: 'unreadable' } : { kind: 'engaged', record }
  } catch {
    return { kind: 'unreadable' }
  } finally {
    try {
      closeSync(fd)
    } catch {
      // Nothing useful to do; the process is short-lived.
    }
  }
}

/** Temp file + rename, so a reader sees the old flag or the new one, never half of one. */
export function writeBrakeFile(stateDir: string, record: BrakeRecord): void {
  writeSecretFile(brakeFilePath(stateDir), serializeBrakeRecord(record))
}

/** False when there was no flag. */
export function removeBrakeFile(stateDir: string): boolean {
  try {
    unlinkSync(brakeFilePath(stateDir))
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** ENOTDIR: a path component is a file, so the flag cannot exist either. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
