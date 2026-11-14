import { join } from 'node:path'
import type { Logger } from '../../application/ports/Logger.ts'
import type {
  CapturedImage,
  CaptureWorkspace,
  ScreenCapturer,
} from '../../application/ports/ScreenCapturer.ts'
import type { CaptureTarget } from '../../domain/capture/CaptureTarget.ts'
import type { ProcessRunner } from '../session/processRunner.ts'

/** The viewport of the capture, a common laptop size. */
export const BROWSER_WINDOW_SIZE = '1280,800'
/** Virtual time the page gets to settle (timers, fetches) before the shot. */
export const BROWSER_VIRTUAL_TIME_BUDGET_MS = 5_000
/** Chromium's own page-load deadline (`--timeout`). */
export const BROWSER_PAGE_TIMEOUT_MS = 20_000
/** Our hard deadline for the whole process; it is killed after this. */
export const BROWSER_PROCESS_TIMEOUT_MS = 45_000

export interface HeadlessBrowserCapturerDeps {
  /** Absolute path of a Chromium-family browser (`discoverBrowser`). */
  readonly browser: string
  readonly run: ProcessRunner
  readonly logger: Logger
}

/**
 * Captures a web page with the installed Chromium-family browser's own
 * headless mode (ADR 0010), instead of Playwright. Every run gets a
 * throwaway profile inside the capture's private workspace, so it never
 * sees the user's cookies or sessions. The URL is the last argument, after
 * `--`, so Chromium never parses it as a switch (and the URL policy already
 * guarantees it starts with `http`).
 */
export class HeadlessBrowserCapturer implements ScreenCapturer {
  readonly kinds = ['url'] as const

  constructor(private readonly deps: HeadlessBrowserCapturerDeps) {}

  async capture(
    target: CaptureTarget,
    workspace: CaptureWorkspace,
    signal?: AbortSignal,
  ): Promise<CapturedImage> {
    if (target.kind !== 'url' || target.url.startsWith('-')) {
      throw new Error('the headless browser only captures http(s) pages')
    }
    const result = await this.deps.run(
      browserArgv(this.deps.browser, target.url, workspace),
      BROWSER_PROCESS_TIMEOUT_MS,
      ...(signal === undefined ? [] : [{ signal }]),
    )
    if (signal?.aborted === true) throw new Error('the capture was cancelled')
    if (result.timedOut) throw new Error('the headless browser timed out')
    if (result.exitCode !== 0) {
      throw new Error(`the headless browser exited with code ${result.exitCode}`)
    }
    this.deps.logger.info('captured a page', { host: target.host })
    return { path: workspace.imagePath, mime: 'image/png' }
  }
}

/** The exact command line; exported for the tests and the docs. */
export function browserArgv(browser: string, url: string, workspace: CaptureWorkspace): string[] {
  return [
    browser,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    `--user-data-dir=${join(workspace.dir, 'profile')}`,
    `--window-size=${BROWSER_WINDOW_SIZE}`,
    `--virtual-time-budget=${BROWSER_VIRTUAL_TIME_BUDGET_MS}`,
    `--timeout=${BROWSER_PAGE_TIMEOUT_MS}`,
    `--screenshot=${workspace.imagePath}`,
    '--',
    url,
  ]
}
