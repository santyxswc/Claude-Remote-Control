import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectFileError } from '../../application/errors.ts'
import type {
  SavedSummary,
  SessionSummaryStore,
} from '../../application/ports/SessionSummaryStore.ts'
import { SESSION_SUMMARY_DIR } from '../../domain/sessions/sessionSummary.ts'
import { ensureContainedDir, isExisting, realProject } from './containment.ts'

/** Names tried before giving up (`x.md`, `x-2.md`, …). */
const MAX_ATTEMPTS = 50

/**
 * Session summaries in `<project>/docs/sessions/` (F12). Each file is created
 * exclusively (`wx`: never overwrites, never follows a link at the name), and
 * a `docs` or `sessions` link leading outside the project is refused.
 */
export class FileSessionSummaryStore implements SessionSummaryStore {
  constructor(private readonly projectDir: string) {}

  async save(name: (attempt: number) => string, content: string): Promise<SavedSummary> {
    const root = await realProject(this.projectDir)
    const dir = await ensureContainedDir(root, SESSION_SUMMARY_DIR)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const fileName = name(attempt)
      let handle: Awaited<ReturnType<typeof open>>
      try {
        handle = await open(join(dir, fileName), 'wx', 0o644)
      } catch (error) {
        if (isExisting(error)) continue
        throw new ProjectFileError('io')
      }
      try {
        await handle.writeFile(content, 'utf8')
      } catch {
        throw new ProjectFileError('io')
      } finally {
        await handle.close()
      }
      return { relativePath: [...SESSION_SUMMARY_DIR, fileName].join('/') }
    }
    throw new ProjectFileError('no_free_name')
  }
}
