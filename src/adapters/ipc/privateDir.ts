import { lstatSync, mkdirSync } from 'node:fs'
import { PRIVATE_DIR_MODE } from '../storage/stateDir.ts'

/**
 * A directory only we can enter: a real directory (not a symlink), owned by
 * this user, with no group or other permission bits. Used for the socket
 * fallback in a shared temp directory, where someone else could have created
 * the name first. POSIX only.
 */
export function isPrivateDir(dir: string): boolean {
  try {
    const stat = lstatSync(dir)
    const uid = process.getuid?.()
    return stat.isDirectory() && uid !== undefined && stat.uid === uid && (stat.mode & 0o077) === 0
  } catch {
    return false
  }
}

/** Creates the directory 0700 if missing; false when it exists but is not private. */
export function ensurePrivateDir(dir: string): boolean {
  try {
    mkdirSync(dir, { mode: PRIVATE_DIR_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false
  }
  return isPrivateDir(dir)
}
