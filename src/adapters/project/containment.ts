import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { ProjectFileError } from '../../application/errors.ts'

/** Whether `path` (already resolved) is `root` or inside it; case-insensitive on Windows. */
export function isInside(root: string, path: string): boolean {
  const a = process.platform === 'win32' ? root.toLowerCase() : root
  const b = process.platform === 'win32' ? path.toLowerCase() : path
  const rel = relative(a, b)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The project directory with every link resolved. */
export async function realProject(projectDir: string): Promise<string> {
  try {
    return await realpath(projectDir)
  } catch {
    throw new ProjectFileError('io')
  }
}

/**
 * Creates `segments` under the project one level at a time, refusing any
 * existing level that is a link (symlink or junction) resolving outside the
 * project or is not a directory. Returns the resolved directory.
 */
export async function ensureContainedDir(
  root: string,
  segments: readonly string[],
): Promise<string> {
  let current = root
  for (const segment of segments) {
    const next = join(current, segment)
    let info: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      info = await lstat(next)
    } catch (error) {
      if (!isMissing(error)) throw new ProjectFileError('io')
    }
    if (info === undefined) {
      try {
        await mkdir(next)
      } catch (error) {
        if (!isExisting(error)) throw new ProjectFileError('io')
      }
    }
    const resolved = await realpath(next).catch(() => {
      throw new ProjectFileError('io')
    })
    if (!isInside(root, resolved)) throw new ProjectFileError('outside_project')
    const real = await lstat(resolved).catch(() => {
      throw new ProjectFileError('io')
    })
    if (!real.isDirectory()) throw new ProjectFileError('not_a_regular_file')
    current = resolved
  }
  return current
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

export function isExisting(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
}
