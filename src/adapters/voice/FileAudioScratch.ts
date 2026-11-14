import { randomBytes } from 'node:crypto'
import { chmod, type FileHandle, mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AudioDraft,
  AudioScratch,
  AudioWorkspace,
} from '../../application/ports/AudioScratch.ts'
import type { Logger } from '../../application/ports/Logger.ts'
import { PRIVATE_DIR_MODE, SECRET_FILE_MODE } from '../storage/stateDir.ts'
import { VOICE_AUDIO_FILE } from './voiceInvocations.ts'

/** Under the state directory, which is already private to the user. */
export const VOICE_SCRATCH_DIR = 'voice'

/** Our own workspace names: 32 hex characters. Nothing else in the root is touched. */
const WORKSPACE_NAME = /^[0-9a-f]{32}$/

/** A workspace older than this is a leftover (the longest deadline is ten minutes). */
export const STALE_WORKSPACE_MS = 30 * 60_000

/**
 * `<stateDir>/voice/<32 hex>/voice.ogg`, directories 0700 and the audio 0600
 * (on Windows the user-profile ACL protects them). The audio file is created
 * exclusively. Each note gets its own directory, so the WAV and the
 * transcript the programs write go away with it.
 */
export class FileAudioScratch implements AudioScratch {
  readonly #root: string
  readonly #open = new Map<string, FileHandle>()

  constructor(
    stateDir: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.#root = join(stateDir, VOICE_SCRATCH_DIR)
  }

  async create(): Promise<AudioDraft> {
    await mkdir(this.#root, { recursive: true, mode: PRIVATE_DIR_MODE })
    await chmod(this.#root, PRIVATE_DIR_MODE)
    const dir = join(this.#root, randomBytes(16).toString('hex'))
    await mkdir(dir, { mode: PRIVATE_DIR_MODE })
    await chmod(dir, PRIVATE_DIR_MODE)
    const handle = await open(join(dir, VOICE_AUDIO_FILE), 'wx', SECRET_FILE_MODE)
    this.#open.set(dir, handle)
    return {
      dir,
      write: async (chunk) => {
        for (let at = 0; at < chunk.length; ) {
          at += (await handle.write(chunk, at, chunk.length - at)).bytesWritten
        }
      },
      close: () => this.#close(dir),
    }
  }

  async dispose(workspace: AudioWorkspace): Promise<void> {
    await this.#close(workspace.dir)
    try {
      await rm(workspace.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (error) {
      this.logger.warn('could not remove a voice workspace', { dir: workspace.dir, error })
    }
  }

  async sweep(): Promise<number> {
    let names: string[]
    try {
      names = await readdir(this.#root)
    } catch {
      return 0
    }
    let removed = 0
    for (const name of names) {
      if (!WORKSPACE_NAME.test(name)) continue
      const dir = join(this.#root, name)
      try {
        const info = await stat(dir)
        if (!info.isDirectory() || this.now() - info.mtimeMs < STALE_WORKSPACE_MS) continue
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        removed += 1
      } catch (error) {
        this.logger.warn('could not remove a stale voice workspace', { dir, error })
      }
    }
    return removed
  }

  async #close(dir: string): Promise<void> {
    const handle = this.#open.get(dir)
    if (handle === undefined) return
    this.#open.delete(dir)
    try {
      await handle.close()
    } catch {
      // Already closed.
    }
  }
}
