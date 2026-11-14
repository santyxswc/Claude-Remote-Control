import type { CaptureWorkspace } from './ScreenCapturer.ts'

export interface CapturedFileInfo {
  readonly bytes: number
  /** The first bytes of the file, enough for an image header. */
  readonly head: Uint8Array
}

/**
 * Private temporary space for captures: a fresh directory per capture with a
 * random name, readable only by us, removed with everything in it.
 */
export interface CaptureScratch {
  create(): Promise<CaptureWorkspace>
  /** Restricts the file to the owner and reads its size and first bytes. */
  inspect(path: string): Promise<CapturedFileInfo>
  /** Never rejects; removes the directory and everything a capturer left in it. */
  dispose(workspace: CaptureWorkspace): Promise<void>
}
