import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CapturedFileInfo, CaptureScratch } from '../../application/ports/CaptureScratch.ts'
import type { Logger } from '../../application/ports/Logger.ts'
import type { CaptureWorkspace } from '../../application/ports/ScreenCapturer.ts'
import { PNG_HEADER_BYTES } from '../../domain/capture/pngSize.ts'
import { PRIVATE_DIR_MODE, SECRET_FILE_MODE } from '../storage/stateDir.ts'

/** Under the state directory, which is already private to the user. */
export const CAPTURE_TMP_DIR = 'tmp'

/**
 * `<stateDir>/tmp/<random>/<random>.png`, directories 0700 and the image
 * 0600 (on Windows the user-profile ACL protects them). Each capture gets
 * its own directory, so the browser's throwaway profile and anything else a
 * tool leaves behind go away with it.
 */
export class FileCaptureScratch implements CaptureScratch {
  readonly #root: string

  constructor(
    stateDir: string,
    private readonly logger: Logger,
  ) {
    this.#root = join(stateDir, CAPTURE_TMP_DIR)
  }

  async create(): Promise<CaptureWorkspace> {
    await mkdir(this.#root, { recursive: true, mode: PRIVATE_DIR_MODE })
    await chmod(this.#root, PRIVATE_DIR_MODE)
    const dir = join(this.#root, randomName(16))
    await mkdir(dir, { mode: PRIVATE_DIR_MODE })
    await chmod(dir, PRIVATE_DIR_MODE)
    return { dir, imagePath: join(dir, `${randomName(8)}.png`) }
  }

  async inspect(path: string): Promise<CapturedFileInfo> {
    await chmod(path, SECRET_FILE_MODE)
    const { size } = await stat(path)
    const file = await open(path, 'r')
    try {
      const head = new Uint8Array(PNG_HEADER_BYTES)
      const { bytesRead } = await file.read(head, 0, head.length, 0)
      return { bytes: size, head: head.subarray(0, bytesRead) }
    } finally {
      await file.close()
    }
  }

  async dispose(workspace: CaptureWorkspace): Promise<void> {
    try {
      await rm(workspace.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (error) {
      this.logger.warn('could not remove a capture directory', { dir: workspace.dir, error })
    }
  }
}

function randomName(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}
