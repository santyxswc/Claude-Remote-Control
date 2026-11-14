import { randomBytes } from 'node:crypto'
import { chmod, type FileHandle, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AttachmentInbox, InboxDraft } from '../../application/ports/AttachmentInbox.ts'
import type { Logger } from '../../application/ports/Logger.ts'
import type { InboxEntry } from '../../domain/attachments/inboxRetention.ts'
import { PRIVATE_DIR_MODE, SECRET_FILE_MODE } from './stateDir.ts'

/** Under the state directory, which is already private to the user. */
export const INBOX_DIR = 'inbox'

/** Session ids are base64url (`buildPermissions`); anything else never becomes a directory. */
const SESSION = /^[A-Za-z0-9_-]{1,64}$/
const EXTENSION = /^[a-z0-9]{1,10}$/
/** The only names this class creates: 32 hex characters, then `.part` or an extension. */
const OUR_FILE = /^[0-9a-f]{32}\.[a-z0-9]{1,10}$/
const PART = '.part'

/**
 * `<stateDir>/inbox/<session>/<random 16 bytes hex>.<ext>` (F10): the
 * directories 0700, files 0600 and never executable (on Windows the
 * user-profile ACL protects them). A file is written as `<random>.part`
 * (created exclusively) and renamed only once it passed every check, so the
 * session never sees a half-written or refused file under a final name.
 * Every path is built from our own names; a sender's file name never
 * reaches this class.
 */
export class FileAttachmentInbox implements AttachmentInbox {
  readonly #root: string
  readonly #dir: string
  readonly #session: string
  /** Drafts being written, so a sweep never removes one. */
  readonly #active = new Set<string>()

  constructor(
    stateDir: string,
    session: string,
    private readonly logger: Logger,
  ) {
    if (!SESSION.test(session)) throw new Error('invalid session id for the inbox')
    this.#session = session
    this.#root = resolve(stateDir, INBOX_DIR)
    this.#dir = join(this.#root, session)
  }

  /** This session's inbox, absolute. */
  get dir(): string {
    return this.#dir
  }

  async draft(extension: string): Promise<InboxDraft> {
    if (!EXTENSION.test(extension)) throw new Error('invalid extension for the inbox')
    for (const dir of [this.#root, this.#dir]) {
      await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
      await chmod(dir, PRIVATE_DIR_MODE)
    }
    const name = randomBytes(16).toString('hex')
    const partPath = join(this.#dir, `${name}${PART}`)
    const finalPath = join(this.#dir, `${name}.${extension}`)
    const handle: FileHandle = await open(partPath, 'wx', SECRET_FILE_MODE)
    this.#active.add(`${name}${PART}`)
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await handle.close()
    }
    return {
      write: async (chunk) => {
        await handle.write(chunk)
      },
      keep: async () => {
        await close()
        await chmod(partPath, SECRET_FILE_MODE)
        await rename(partPath, finalPath)
        this.#active.delete(`${name}${PART}`)
        return finalPath
      },
      discard: async () => {
        try {
          await close()
        } catch {
          // Removing it is what matters.
        }
        await rm(partPath, { force: true, maxRetries: 10, retryDelay: 50 }).catch((error) =>
          this.logger.warn('could not remove a refused incoming file', { error }),
        )
        this.#active.delete(`${name}${PART}`)
      },
    }
  }

  async list(): Promise<readonly InboxEntry[]> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch {
      return []
    }
    const entries: InboxEntry[] = []
    for (const name of names) {
      if (this.#active.has(name)) continue
      try {
        const info = await lstat(join(this.#dir, name))
        if (info.isFile()) entries.push({ name, bytes: info.size, modifiedAt: info.mtimeMs })
      } catch {
        // Gone in between.
      }
    }
    return entries
  }

  async remove(names: readonly string[]): Promise<number> {
    let removed = 0
    for (const name of names) {
      // Only names we create (a leftover `.part` of a crash included), never a path.
      if (!OUR_FILE.test(name) || this.#active.has(name)) continue
      try {
        await rm(join(this.#dir, name), { force: true, maxRetries: 10, retryDelay: 50 })
        removed += 1
      } catch (error) {
        this.logger.warn('could not remove an incoming file', { error })
      }
    }
    return removed
  }

  async removeOtherSessions(only?: ReadonlySet<string>): Promise<number> {
    let names: string[]
    try {
      names = await readdir(this.#root)
    } catch {
      return 0
    }
    let removed = 0
    for (const name of names) {
      if (name === this.#session || (only !== undefined && !only.has(name))) continue
      try {
        // A symlink is removed itself, never followed.
        await rm(join(this.#root, name), {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 50,
        })
        removed += 1
      } catch (error) {
        this.logger.warn('could not remove an earlier inbox', { error })
      }
    }
    return removed
  }
}
