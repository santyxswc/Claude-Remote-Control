export interface SavedSummary {
  /** Relative to the project, with `/` separators, e.g. `docs/sessions/2026-…-x.md`. */
  readonly relativePath: string
}

/**
 * Writes session summaries into the project's `docs/sessions/` (F12). Never
 * overwrites: `name(attempt)` gives the file name to try, the next attempt
 * after a collision. Rejects with `ProjectFileError`.
 */
export interface SessionSummaryStore {
  save(name: (attempt: number) => string, content: string): Promise<SavedSummary>
}
