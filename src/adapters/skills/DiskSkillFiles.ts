import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import type { Logger } from '../../application/ports/Logger.ts'
import type { SkillFile, SkillFiles, SkillScan } from '../../application/ports/SkillFiles.ts'

/** A `SKILL.md` larger than this is not read (the frontmatter is at its top anyway). */
export const MAX_SKILL_FILE_BYTES = 64 * 1024
/** Skill directories looked at per root, at most. */
export const MAX_SKILL_DIRS = 500

const PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR'

export interface DiskSkillFilesOptions {
  /** The project, when known: its `.claude/skills/*` are read. */
  readonly projectDir: string | undefined
  /** `<Claude config dir>/skills`. */
  readonly userSkillsDir: string | undefined
  readonly logger: Logger
}

/**
 * Reads `<root>/<name>/SKILL.md` under the user and project skill
 * directories (F7). Read-only and defensive: files over 64 KiB, unreadable
 * ones and anything whose real path (symlinks resolved) is outside its root
 * are skipped. Plugin skills are not read (their install location is
 * Claude Code's business).
 */
export class DiskSkillFiles implements SkillFiles {
  constructor(private readonly options: DiskSkillFilesOptions) {}

  async scan(): Promise<SkillScan> {
    const { projectDir, userSkillsDir } = this.options
    const files = [
      ...(userSkillsDir === undefined ? [] : await this.#read(userSkillsDir, 'user')),
      ...(projectDir === undefined
        ? []
        : await this.#read(join(projectDir, '.claude', 'skills'), 'project')),
    ]
    return { projectKnown: projectDir !== undefined, files }
  }

  async #read(root: string, scope: SkillFile['scope']): Promise<SkillFile[]> {
    let realRoot: string
    let names: string[]
    try {
      realRoot = await realpath(root)
      names = (await readdir(realRoot)).slice(0, MAX_SKILL_DIRS)
    } catch {
      return []
    }
    const files: SkillFile[] = []
    for (const dirName of names.sort()) {
      if (dirName.startsWith('.')) continue
      const content = await this.#readSkill(realRoot, dirName)
      if (content !== undefined) files.push({ dirName, content, scope })
    }
    return files
  }

  async #readSkill(realRoot: string, dirName: string): Promise<string | undefined> {
    try {
      const real = await realpath(join(realRoot, dirName, 'SKILL.md'))
      if (!real.startsWith(realRoot + sep)) {
        this.options.logger.warn('skipped a skill outside its skills directory', { dirName })
        return undefined
      }
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_SKILL_FILE_BYTES) return undefined
      const handle = await open(real, 'r')
      try {
        const buffer = new Uint8Array(MAX_SKILL_FILE_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        return new TextDecoder().decode(buffer.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }
}

/**
 * The project directory for `/skills`: `CLAUDE_PROJECT_DIR` when it is an
 * absolute path, else the working directory if it looks like a project (it
 * has `.claude/` or `.git`); otherwise unknown.
 */
export function resolveProjectDir(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  exists: (path: string) => boolean,
): string | undefined {
  const fromEnv = env[PROJECT_DIR_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv !== '' && isAbsolute(fromEnv)) return fromEnv
  return exists(join(cwd, '.claude')) || exists(join(cwd, '.git')) ? cwd : undefined
}
