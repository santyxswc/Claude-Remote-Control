import type { CaptureKind, CaptureTarget } from '../../domain/capture/CaptureTarget.ts'

/** A private, per-capture directory and the image path inside it, both ours. */
export interface CaptureWorkspace {
  readonly dir: string
  readonly imagePath: string
}

export interface CapturedImage {
  readonly path: string
  readonly mime: string
}

/**
 * GoF Strategy: one way to take a screenshot (a headless browser, grim,
 * PowerShell...). A Factory Method in the adapters picks the strategies for
 * this OS and display server; the use case only asks which kinds they cover.
 */
export interface ScreenCapturer {
  readonly kinds: readonly CaptureKind[]
  /**
   * Writes the image into the workspace. Rejects when nothing usable was
   * produced, or when `signal` aborts (shutdown): the program is killed.
   */
  capture(
    target: CaptureTarget,
    workspace: CaptureWorkspace,
    signal?: AbortSignal,
  ): Promise<CapturedImage>
}

/** Why a kind cannot be captured here, and what would enable it. */
export interface CaptureUnavailable {
  readonly reason: 'no_display' | 'no_tool' | 'no_browser' | 'invalid_browser_override'
  /** Programs (or settings) that would make it work on this platform. */
  readonly remedies: readonly string[]
}
