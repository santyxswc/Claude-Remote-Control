import { randomBytes } from 'node:crypto'
import { lstat, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProjectFileError } from '../../application/errors.ts'
import type { AppendedNotes, ProjectMemoryFile } from '../../application/ports/ProjectMemoryFile.ts'
import { MEMORY_FILE_NAME } from '../../application/use-cases/ResolveMemoryProposal.ts'
import { appendSessionNotes } from '../../domain/memory/sessionNotes.ts'
import { isInside, isMissing, realProject } from './containment.ts'

/** A larger `CLAUDE.md` is not something the bridge should rewrite. */
export const MAX_MEMORY_FILE_BYTES = 1_000_000

interface Target {
  /** The real file (a contained link is followed to it). */
  readonly path: string
  readonly existing: string
  /** Size and modification time when read, `undefined` if the file did not exist. */
  readonly seen:
    | { readonly size: number; readonly mtimeMs: number; readonly mode: number }
    | undefined
}

/**
 * The project's `CLAUDE.md` (F12). Approved lines are added with
 * `appendSessionNotes` and the file is replaced atomically: the new content
 * goes to a temporary file next to it, which is renamed over it, so a crash
 * leaves either the old or the new file. Refused: a link leading outside the
 * project, anything that is not a regular file, a file above 1 MB, and a file
 * that changed between reading and renaming.
 */
export class ClaudeMdMemoryFile implements ProjectMemoryFile {
  constructor(private readonly projectDir: string) {}

  async append(lines: readonly string[]): Promise<AppendedNotes> {
    const root = await realProject(this.projectDir)
    const target = await this.#read(root)
    const next = appendSessionNotes(target.existing, lines)
    const temp = join(
      dirname(target.path),
      `.${MEMORY_FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`,
    )
    try {
      const handle = await open(temp, 'wx', target.seen?.mode ?? 0o644)
      try {
        await handle.writeFile(next, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#unchanged(target)
      await rename(temp, target.path)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error instanceof ProjectFileError ? error : new ProjectFileError('io')
    }
    return { relativePath: MEMORY_FILE_NAME, created: target.seen === undefined }
  }

  async #read(root: string): Promise<Target> {
    const path = join(root, MEMORY_FILE_NAME)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(path)
    } catch (error) {
      if (isMissing(error)) return { path, existing: '', seen: undefined }
      throw new ProjectFileError('io')
    }
    let real = path
    if (info.isSymbolicLink()) {
      real = await realpath(path).catch(() => {
        throw new ProjectFileError('outside_project')
      })
      if (!isInside(root, real)) throw new ProjectFileError('outside_project')
      info = await stat(real).catch(() => {
        throw new ProjectFileError('io')
      })
    }
    if (!info.isFile()) throw new ProjectFileError('not_a_regular_file')
    if (info.size > MAX_MEMORY_FILE_BYTES) throw new ProjectFileError('too_large')
    const existing = await readFile(real, 'utf8').catch(() => {
      throw new ProjectFileError('io')
    })
    return {
      path: real,
      existing,
      seen: { size: info.size, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 },
    }
  }

  /** Someone (an editor, Claude) wrote the file after it was read: do not overwrite that. */
  async #unchanged(target: Target): Promise<void> {
    let now: Awaited<ReturnType<typeof stat>> | undefined
    try {
      now = await stat(target.path)
    } catch (error) {
      if (!isMissing(error)) throw new ProjectFileError('io')
    }
    const same =
      target.seen === undefined
        ? now === undefined
        : now !== undefined && now.size === target.seen.size && now.mtimeMs === target.seen.mtimeMs
    if (!same) throw new ProjectFileError('changed_meanwhile')
  }
}
