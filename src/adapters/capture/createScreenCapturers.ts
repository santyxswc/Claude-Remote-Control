import { posix, win32 } from 'node:path'
import type { Logger } from '../../application/ports/Logger.ts'
import type { CaptureUnavailable, ScreenCapturer } from '../../application/ports/ScreenCapturer.ts'
import type { CaptureKind } from '../../domain/capture/CaptureTarget.ts'
import type { ProcessRunner } from '../session/processRunner.ts'
import { CommandScreenCapturer, type ScreenTool } from './CommandScreenCapturer.ts'
import { BROWSER_ENV, discoverBrowser } from './discoverBrowser.ts'
import { HeadlessBrowserCapturer } from './HeadlessBrowserCapturer.ts'
import type { SystemProbe } from './systemProbe.ts'

export interface CaptureContext {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly homeDir: string
  readonly probe: SystemProbe
  readonly run: ProcessRunner
  readonly logger: Logger
}

export interface CaptureSetup {
  readonly capturers: readonly ScreenCapturer[]
  readonly unavailable: Readonly<Partial<Record<CaptureKind, CaptureUnavailable>>>
}

/** The Windows script reads its output path from here, never from its own text. */
export const WINDOWS_SHOT_PATH_ENV = 'TELEGRAM_BRIDGE_SHOT_PATH'

/**
 * The whole virtual screen (every monitor) in physical pixels: per-monitor
 * DPI awareness first (falling back to system awareness), then
 * `Graphics.CopyFromScreen` into a PNG. A constant: the output path arrives
 * through `TELEGRAM_BRIDGE_SHOT_PATH`.
 */
export const WINDOWS_CAPTURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `Add-Type -Name Dpi -Namespace TelegramBridge -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'`,
  'try { $aware = [TelegramBridge.Dpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { $aware = $false }',
  'if (-not $aware) { [void][TelegramBridge.Dpi]::SetProcessDPIAware() }',
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
  '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
  '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
  `try { $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size); $bitmap.Save($env:${WINDOWS_SHOT_PATH_ENV}, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $graphics.Dispose(); $bitmap.Dispose() }`,
].join('\n')

const SYSTEM_ROOT_ENV = 'SystemRoot'
const SESSION_TYPE_ENV = 'XDG_SESSION_TYPE'
const WAYLAND_DISPLAY_ENV = 'WAYLAND_DISPLAY'
const X11_DISPLAY_ENV = 'DISPLAY'

const WAYLAND_TOOLS = ['grim', 'spectacle', 'gnome-screenshot'] as const
const X11_TOOLS = ['maim', 'scrot', 'import'] as const

/** What to tell the owner to install, per environment. */
export const REMEDIES = {
  wayland: ['grim (Sway, Hyprland)', 'spectacle (KDE)', 'gnome-screenshot (GNOME)'],
  x11: ['maim', 'scrot', 'imagemagick (import)'],
  darwin: ['screencapture'],
  win32: ['powershell.exe'],
  browser: [
    'chromium',
    'google-chrome',
    'brave',
    'microsoft-edge',
    `${BROWSER_ENV}=<absolute path>`,
  ],
} as const

/**
 * GoF Factory Method: the capture strategies for this OS and display server.
 * Pages: the installed Chromium-family browser, headless (any OS, no display
 * needed). Screen: Wayland (grim, spectacle, gnome-screenshot) or X11 (maim,
 * scrot, ImageMagick import) on Linux, `screencapture` on macOS, PowerShell
 * on Windows. A kind left uncovered says why and what would enable it. Pure
 * over the injected env and probe; nothing runs until a capture.
 */
export function createScreenCapturers(context: CaptureContext): CaptureSetup {
  const capturers: ScreenCapturer[] = []
  const unavailable: Partial<Record<CaptureKind, CaptureUnavailable>> = {}
  const { run, logger } = context

  const screen = screenTools(context)
  if ('tools' in screen) {
    capturers.push(new CommandScreenCapturer({ tools: screen.tools, run, logger }))
  } else {
    unavailable.screen = screen
  }

  const browser = discoverBrowser(context)
  if (browser.found) {
    capturers.push(new HeadlessBrowserCapturer({ browser: browser.path, run, logger }))
  } else {
    unavailable.url = { reason: browser.reason, remedies: REMEDIES.browser }
  }
  return { capturers, unavailable }
}

function screenTools(
  context: CaptureContext,
): { readonly tools: readonly ScreenTool[] } | CaptureUnavailable {
  const { platform, env, probe } = context
  if (platform === 'win32') {
    const systemRoot = env[SYSTEM_ROOT_ENV]
    const bundled =
      systemRoot === undefined || systemRoot === ''
        ? undefined
        : win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const powershell =
      bundled !== undefined && probe.isFile(bundled) ? bundled : probe.which('powershell.exe')
    return powershell === undefined
      ? { reason: 'no_tool', remedies: REMEDIES.win32 }
      : { tools: [windowsTool(powershell)] }
  }
  if (platform === 'darwin') {
    const screencapture = posix.join(posix.sep, 'usr', 'sbin', 'screencapture')
    const found = probe.isFile(screencapture) ? screencapture : probe.which('screencapture')
    return found === undefined
      ? { reason: 'no_tool', remedies: REMEDIES.darwin }
      : { tools: [{ name: 'screencapture', argv: (out) => [found, '-x', out] }] }
  }

  const wayland = env[SESSION_TYPE_ENV] === 'wayland' || nonBlank(env[WAYLAND_DISPLAY_ENV])
  const x11 = !wayland && nonBlank(env[X11_DISPLAY_ENV])
  if (!wayland && !x11) {
    return { reason: 'no_display', remedies: [...REMEDIES.wayland, ...REMEDIES.x11] }
  }
  const names = wayland ? WAYLAND_TOOLS : X11_TOOLS
  const tools = names.flatMap((name) => {
    const path = probe.which(name)
    return path === undefined ? [] : [unixTool(name, path)]
  })
  return tools.length > 0
    ? { tools }
    : { reason: 'no_tool', remedies: wayland ? REMEDIES.wayland : REMEDIES.x11 }
}

/** Each tool's full-screen, non-interactive, write-to-this-file form (see docs/flows/F5.md). */
function unixTool(
  name: (typeof WAYLAND_TOOLS | typeof X11_TOOLS)[number],
  path: string,
): ScreenTool {
  switch (name) {
    case 'grim':
      return { name, argv: (out) => [path, out] }
    case 'spectacle':
      return {
        name,
        argv: (out) => [path, '--background', '--nonotify', '--fullscreen', '--output', out],
      }
    case 'gnome-screenshot':
      return { name, argv: (out) => [path, '--file', out] }
    case 'maim':
      return { name, argv: (out) => [path, out] }
    case 'scrot':
      return { name, argv: (out) => [path, '--overwrite', out] }
    case 'import':
      return { name, argv: (out) => [path, '-window', 'root', out] }
  }
}

function windowsTool(powershell: string): ScreenTool {
  const encoded = Buffer.from(WINDOWS_CAPTURE_SCRIPT, 'utf16le').toString('base64')
  return {
    name: 'powershell',
    argv: () => [
      powershell,
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded,
    ],
    env: (out) => ({ [WINDOWS_SHOT_PATH_ENV]: out }),
  }
}

function nonBlank(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== ''
}
