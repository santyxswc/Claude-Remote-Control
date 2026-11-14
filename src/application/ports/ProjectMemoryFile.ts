export interface AppendedNotes {
  /** Relative to the project, e.g. `CLAUDE.md`. */
  readonly relativePath: string
  /** The file did not exist before. */
  readonly created: boolean
}

/**
 * The project's `CLAUDE.md` (F12): approved lines are appended under the
 * session notes heading, atomically, keeping everything else as it was.
 * Rejects with `ProjectFileError`.
 */
export interface ProjectMemoryFile {
  append(lines: readonly string[]): Promise<AppendedNotes>
}
