/** One `SKILL.md`, as read from disk (size-capped). */
export interface SkillFile {
  /** The skill's directory name, the default skill name. */
  readonly dirName: string
  readonly content: string
  readonly scope: 'user' | 'project'
}

export interface SkillScan {
  /** False when no project directory is known: only user skills were read. */
  readonly projectKnown: boolean
  readonly files: readonly SkillFile[]
}

/** Where Claude Code's skills live on this machine (F7 `/skills`). */
export interface SkillFiles {
  /** Never rejects: unreadable, oversized or out-of-tree files are skipped. */
  scan(): Promise<SkillScan>
}
