import { posix, win32 } from 'node:path'
import type { SystemProbe } from './systemProbe.ts'

/** An absolute path to a Chromium-family browser, which wins over discovery. */
export const BROWSER_ENV = 'TELEGRAM_BRIDGE_BROWSER'

/** Names on `PATH` (Linux and other Unix), in order of preference. */
export const LINUX_BROWSERS = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'brave',
  'brave-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
] as const

/** `<base env var>`, then the path below it, for the standard Windows installs. */
const WINDOWS_INSTALLS: readonly (readonly [string, readonly string[]])[] = [
  ['ProgramFiles', ['Google', 'Chrome', 'Application', 'chrome.exe']],
  ['ProgramFiles(x86)', ['Google', 'Chrome', 'Application', 'chrome.exe']],
  ['LOCALAPPDATA', ['Google', 'Chrome', 'Application', 'chrome.exe']],
  ['LOCALAPPDATA', ['Chromium', 'Application', 'chrome.exe']],
  ['ProgramFiles', ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']],
  ['LOCALAPPDATA', ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']],
  ['ProgramFiles(x86)', ['Microsoft', 'Edge', 'Application', 'msedge.exe']],
  ['ProgramFiles', ['Microsoft', 'Edge', 'Application', 'msedge.exe']],
]

/** App bundles, looked up in `/Applications` and then `~/Applications`. */
const MAC_APPS: readonly (readonly [string, string])[] = [
  ['Google Chrome.app', 'Google Chrome'],
  ['Chromium.app', 'Chromium'],
  ['Brave Browser.app', 'Brave Browser'],
  ['Microsoft Edge.app', 'Microsoft Edge'],
]

export interface BrowserContext {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly homeDir: string
  readonly probe: SystemProbe
}

export type BrowserDiscovery =
  | { readonly found: true; readonly path: string }
  | { readonly found: false; readonly reason: 'no_browser' | 'invalid_browser_override' }

/**
 * GoF Factory Method input: which browser `HeadlessBrowserCapturer` runs.
 * `TELEGRAM_BRIDGE_BROWSER` wins when set; if it is not an absolute path to a
 * file, page captures stay off rather than silently using another browser.
 * Pure over the injected probe.
 */
export function discoverBrowser(context: BrowserContext): BrowserDiscovery {
  const { platform, env, probe } = context
  const path = platform === 'win32' ? win32 : posix
  const override = env[BROWSER_ENV]?.trim()
  if (override !== undefined && override !== '') {
    return path.isAbsolute(override) && probe.isFile(override)
      ? { found: true, path: override }
      : { found: false, reason: 'invalid_browser_override' }
  }
  for (const candidate of candidates(context)) {
    const resolved = path.isAbsolute(candidate)
      ? probe.isFile(candidate)
        ? candidate
        : undefined
      : probe.which(candidate)
    if (resolved !== undefined) return { found: true, path: resolved }
  }
  return { found: false, reason: 'no_browser' }
}

function candidates({ platform, env, homeDir }: BrowserContext): readonly string[] {
  if (platform === 'win32') {
    return WINDOWS_INSTALLS.flatMap(([base, rest]) => {
      const root = env[base]
      return root === undefined || root === '' ? [] : [win32.join(root, ...rest)]
    })
  }
  if (platform === 'darwin') {
    const roots = [posix.join(posix.sep, 'Applications'), posix.join(homeDir, 'Applications')]
    return roots.flatMap((root) =>
      MAC_APPS.map(([bundle, binary]) => posix.join(root, bundle, 'Contents', 'MacOS', binary)),
    )
  }
  return LINUX_BROWSERS
}
