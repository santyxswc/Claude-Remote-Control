/**
 * The capture strategies and their factory, with a fake process runner and
 * a fake probe: nothing here starts a real browser or screenshot tool.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import {
  CommandScreenCapturer,
  SCREEN_TOOL_TIMEOUT_MS,
} from '../../../src/adapters/capture/CommandScreenCapturer.ts'
import {
  type CaptureContext,
  createScreenCapturers,
  REMEDIES,
  WINDOWS_CAPTURE_SCRIPT,
  WINDOWS_SHOT_PATH_ENV,
} from '../../../src/adapters/capture/createScreenCapturers.ts'
import { BROWSER_ENV, discoverBrowser } from '../../../src/adapters/capture/discoverBrowser.ts'
import { FileCaptureScratch } from '../../../src/adapters/capture/FileCaptureScratch.ts'
import {
  BROWSER_PROCESS_TIMEOUT_MS,
  HeadlessBrowserCapturer,
} from '../../../src/adapters/capture/HeadlessBrowserCapturer.ts'
import type { CaptureWorkspace } from '../../../src/application/ports/ScreenCapturer.ts'
import type { CaptureTarget } from '../../../src/domain/capture/CaptureTarget.ts'
import { parseCaptureUrl } from '../../../src/domain/capture/captureUrl.ts'
import { MemoryLogger } from '../../fakes.ts'
import { makePng } from '../../png.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'
import { fakeProbe, fakeRunner } from './captureFakes.ts'

const SCREEN: CaptureTarget = { kind: 'screen' }

function urlTarget(raw: string): CaptureTarget {
  const parsed = parseCaptureUrl(raw)
  if (!parsed.ok) throw new Error(`bad test url ${raw}`)
  return parsed.target
}

let dir: string
let workspace: CaptureWorkspace

beforeEach(() => {
  dir = makeTempDir()
  workspace = { dir, imagePath: join(dir, 'shot.png') }
})

afterEach(() => removeTempDir(dir))

describe('discoverBrowser', () => {
  const base = { homeDir: '/home/ana', env: {} }

  test('Linux: the first known name on PATH, as an absolute path', () => {
    const { probe, asked } = fakeProbe([], {
      brave: '/usr/bin/brave',
      chromium: '/usr/bin/chromium',
    })
    expect(discoverBrowser({ ...base, platform: 'linux', probe })).toEqual({
      found: true,
      path: '/usr/bin/chromium',
    })
    expect(asked).toEqual(['chromium'])
    const onlyBrave = fakeProbe([], { brave: '/usr/bin/brave' }).probe
    expect(discoverBrowser({ ...base, platform: 'linux', probe: onlyBrave })).toEqual({
      found: true,
      path: '/usr/bin/brave',
    })
  })

  test('Windows: the standard install locations under the profile env vars', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local',
    }
    const edge = win32.join(
      env['ProgramFiles(x86)'],
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe',
    )
    const { probe, asked } = fakeProbe([edge])
    expect(discoverBrowser({ ...base, env, platform: 'win32', probe })).toEqual({
      found: true,
      path: edge,
    })
    expect(asked[0]).toBe(
      win32.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    )
    expect(asked).not.toContain('chromium')
  })

  test('macOS: app bundles in /Applications, then ~/Applications', () => {
    const brave = posix.join(
      '/home/ana',
      'Applications',
      'Brave Browser.app',
      'Contents',
      'MacOS',
      'Brave Browser',
    )
    const { probe, asked } = fakeProbe([brave])
    expect(discoverBrowser({ ...base, platform: 'darwin', probe })).toEqual({
      found: true,
      path: brave,
    })
    expect(asked[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  test('nothing installed: no_browser', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(discoverBrowser({ ...base, platform, probe: fakeProbe().probe })).toEqual({
        found: false,
        reason: 'no_browser',
      })
    }
  })

  test('the override wins, but only as an absolute path to an existing file', () => {
    const { probe } = fakeProbe(['/opt/thorium/thorium'], { chromium: '/usr/bin/chromium' })
    const at = (value: string) =>
      discoverBrowser({ ...base, platform: 'linux', env: { [BROWSER_ENV]: value }, probe })
    expect(at('/opt/thorium/thorium')).toEqual({ found: true, path: '/opt/thorium/thorium' })
    expect(at('thorium')).toEqual({ found: false, reason: 'invalid_browser_override' })
    expect(at('/opt/missing')).toEqual({ found: false, reason: 'invalid_browser_override' })
    expect(at('  ')).toEqual({ found: true, path: '/usr/bin/chromium' })
  })
})

describe('createScreenCapturers', () => {
  function context(
    platform: NodeJS.Platform,
    env: Record<string, string>,
    probe = fakeProbe().probe,
  ): CaptureContext {
    return {
      platform,
      env,
      homeDir: '/home/ana',
      probe,
      run: fakeRunner().run,
      logger: new MemoryLogger(),
    }
  }

  /** The tool names a factory's screen capturer would try, by running each against a failing runner. */
  async function screenToolArgv(ctx: CaptureContext): Promise<string[][]> {
    const { run, calls } = fakeRunner(
      { exitCode: 1, timedOut: false },
      { exitCode: 1, timedOut: false },
      { exitCode: 1, timedOut: false },
    )
    const setup = createScreenCapturers({ ...ctx, run })
    const screen = setup.capturers.find((c) => c.kinds.includes('screen'))
    if (screen === undefined) return []
    await screen.capture(SCREEN, workspace).catch(() => undefined)
    return calls.map((c) => [...c.argv])
  }

  test('Wayland: grim, then spectacle, then gnome-screenshot (only the installed ones)', async () => {
    const probe = fakeProbe([], {
      grim: '/usr/bin/grim',
      spectacle: '/usr/bin/spectacle',
      'gnome-screenshot': '/usr/bin/gnome-screenshot',
      maim: '/usr/bin/maim',
    }).probe
    const out = workspace.imagePath
    expect(
      await screenToolArgv(
        context('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, probe),
      ),
    ).toEqual([
      ['/usr/bin/grim', out],
      ['/usr/bin/spectacle', '--background', '--nonotify', '--fullscreen', '--output', out],
      ['/usr/bin/gnome-screenshot', '--file', out],
    ])
    const onlySpectacle = fakeProbe([], { spectacle: '/usr/bin/spectacle' }).probe
    expect(
      await screenToolArgv(context('linux', { XDG_SESSION_TYPE: 'wayland' }, onlySpectacle)),
    ).toEqual([
      ['/usr/bin/spectacle', '--background', '--nonotify', '--fullscreen', '--output', out],
    ])
  })

  test('X11: maim, then scrot, then ImageMagick import', async () => {
    const probe = fakeProbe([], {
      grim: '/usr/bin/grim',
      maim: '/usr/bin/maim',
      scrot: '/usr/bin/scrot',
      import: '/usr/bin/import',
    }).probe
    const out = workspace.imagePath
    expect(await screenToolArgv(context('linux', { DISPLAY: ':0' }, probe))).toEqual([
      ['/usr/bin/maim', out],
      ['/usr/bin/scrot', '--overwrite', out],
      ['/usr/bin/import', '-window', 'root', out],
    ])
  })

  test('macOS: screencapture -x, silently', async () => {
    const probe = fakeProbe(['/usr/sbin/screencapture']).probe
    expect(await screenToolArgv(context('darwin', {}, probe))).toEqual([
      ['/usr/sbin/screencapture', '-x', workspace.imagePath],
    ])
  })

  test('Windows: the bundled PowerShell with a constant encoded script; the path goes by env', async () => {
    const powershell = win32.join(
      'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    const { run, calls } = fakeRunner()
    const setup = createScreenCapturers({
      ...context('win32', { SystemRoot: 'C:\\Windows' }, fakeProbe([powershell]).probe),
      run,
    })
    const screen = setup.capturers.find((c) => c.kinds.includes('screen'))
    expect(await screen?.capture(SCREEN, workspace)).toEqual({
      path: workspace.imagePath,
      mime: 'image/png',
    })
    const call = calls[0]
    expect(call?.argv.slice(0, 5)).toEqual([
      powershell,
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ])
    const script = Buffer.from(call?.argv[5] ?? '', 'base64').toString('utf16le')
    expect(script).toBe(WINDOWS_CAPTURE_SCRIPT)
    expect(script).not.toContain(workspace.imagePath)
    expect(script).toContain(`$env:${WINDOWS_SHOT_PATH_ENV}`)
    expect(script).toContain('VirtualScreen')
    expect(script).toContain('SetProcessDpiAwarenessContext')
    expect(call?.options).toEqual({ env: { [WINDOWS_SHOT_PATH_ENV]: workspace.imagePath } })
    expect(call?.timeoutMs).toBe(SCREEN_TOOL_TIMEOUT_MS)
  })

  test('no display, or no tool: screen unavailable with what to install', () => {
    expect(createScreenCapturers(context('linux', {})).unavailable.screen).toEqual({
      reason: 'no_display',
      remedies: [...REMEDIES.wayland, ...REMEDIES.x11],
    })
    expect(
      createScreenCapturers(context('linux', { WAYLAND_DISPLAY: 'wayland-0' })).unavailable.screen,
    ).toEqual({
      reason: 'no_tool',
      remedies: REMEDIES.wayland,
    })
    expect(createScreenCapturers(context('linux', { DISPLAY: ':1' })).unavailable.screen).toEqual({
      reason: 'no_tool',
      remedies: REMEDIES.x11,
    })
    expect(createScreenCapturers(context('darwin', {})).unavailable.screen?.reason).toBe('no_tool')
    expect(createScreenCapturers(context('win32', {})).unavailable.screen?.reason).toBe('no_tool')
  })

  test('pages need a browser; a headless Linux box can still capture them', () => {
    const probe = fakeProbe([], { chromium: '/usr/bin/chromium' }).probe
    const setup = createScreenCapturers(context('linux', {}, probe))
    expect(setup.capturers.map((c) => c.kinds)).toEqual([['url']])
    expect(setup.unavailable).toEqual({ screen: expect.objectContaining({ reason: 'no_display' }) })
    const none = createScreenCapturers(context('linux', {}))
    expect(none.capturers).toEqual([])
    expect(none.unavailable.url).toEqual({ reason: 'no_browser', remedies: REMEDIES.browser })
  })
})

describe('HeadlessBrowserCapturer', () => {
  const BROWSER = '/usr/bin/chromium'

  test('the exact argv: headless, throwaway profile in the workspace, URL last after --', async () => {
    const { run, calls } = fakeRunner()
    const capturer = new HeadlessBrowserCapturer({
      browser: BROWSER,
      run,
      logger: new MemoryLogger(),
    })
    const target = urlTarget('localhost:3000/app?q=1')
    expect(await capturer.capture(target, workspace)).toEqual({
      path: workspace.imagePath,
      mime: 'image/png',
    })
    expect(calls).toEqual([
      {
        argv: [
          BROWSER,
          '--headless=new',
          '--disable-gpu',
          '--hide-scrollbars',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-component-update',
          `--user-data-dir=${join(dir, 'profile')}`,
          '--window-size=1280,800',
          '--virtual-time-budget=5000',
          '--timeout=20000',
          `--screenshot=${workspace.imagePath}`,
          '--',
          'http://localhost:3000/app?q=1',
        ],
        timeoutMs: BROWSER_PROCESS_TIMEOUT_MS,
        options: undefined,
      },
    ])
  })

  test('a URL is never placed where it could be read as a flag', async () => {
    const { run, calls } = fakeRunner()
    const capturer = new HeadlessBrowserCapturer({
      browser: BROWSER,
      run,
      logger: new MemoryLogger(),
    })
    const forged: CaptureTarget = { kind: 'url', url: '--remote-debugging-port=9222', host: 'x' }
    await expect(capturer.capture(forged, workspace)).rejects.toThrow()
    await expect(capturer.capture(SCREEN, workspace)).rejects.toThrow()
    expect(calls).toEqual([])
  })

  test.each([
    ['a non-zero exit', { exitCode: 21, timedOut: false }, 'exited with code 21'],
    ['a timeout', { exitCode: null, timedOut: true }, 'timed out'],
    ['a missing binary', new Error('ENOENT'), 'ENOENT'],
  ])('%s rejects', async (_label, result, message) => {
    const { run } = fakeRunner(result)
    const capturer = new HeadlessBrowserCapturer({
      browser: BROWSER,
      run,
      logger: new MemoryLogger(),
    })
    await expect(capturer.capture(urlTarget('localhost:3000'), workspace)).rejects.toThrow(message)
  })
})

describe('CommandScreenCapturer', () => {
  const tool = (name: string) => ({ name, argv: (out: string) => [`/usr/bin/${name}`, out] })

  test('falls through to the next tool when one fails or leaves no image', async () => {
    const logger = new MemoryLogger()
    const { run, calls } = fakeRunner(
      { exitCode: 1, timedOut: false },
      'no-file',
      new Error('EACCES'),
      {
        exitCode: 0,
        timedOut: false,
      },
    )
    const capturer = new CommandScreenCapturer({
      tools: [tool('grim'), tool('spectacle'), tool('broken'), tool('gnome-screenshot')],
      run,
      logger,
    })
    expect(await capturer.capture(SCREEN, workspace)).toEqual({
      path: workspace.imagePath,
      mime: 'image/png',
    })
    expect(calls.map((c) => c.argv[0])).toEqual([
      '/usr/bin/grim',
      '/usr/bin/spectacle',
      '/usr/bin/broken',
      '/usr/bin/gnome-screenshot',
    ])
    expect(calls.every((c) => c.timeoutMs === SCREEN_TOOL_TIMEOUT_MS)).toBe(true)
    expect(logger.entries.filter((e) => e.level === 'warn')).toHaveLength(3)
  })

  test('a leftover file from a failed tool does not count as the next tool success', async () => {
    writeFileSync(workspace.imagePath, makePng(1, 1))
    const { run } = fakeRunner('no-file')
    const capturer = new CommandScreenCapturer({
      tools: [tool('scrot')],
      run,
      logger: new MemoryLogger(),
    })
    await expect(capturer.capture(SCREEN, workspace)).rejects.toThrow(
      'no screen capture tool succeeded (scrot)',
    )
    expect(existsSync(workspace.imagePath)).toBe(false)
  })

  test('a timeout is a failure', async () => {
    const { run } = fakeRunner({ exitCode: null, timedOut: true })
    const capturer = new CommandScreenCapturer({
      tools: [tool('grim')],
      run,
      logger: new MemoryLogger(),
    })
    await expect(capturer.capture(SCREEN, workspace)).rejects.toThrow()
    await expect(capturer.capture(urlTarget('localhost'), workspace)).rejects.toThrow()
  })
})

describe('FileCaptureScratch', () => {
  test('a private directory per capture under <stateDir>/tmp, removed with everything in it', async () => {
    const scratch = new FileCaptureScratch(dir, new MemoryLogger())
    const first = await scratch.create()
    const second = await scratch.create()
    expect(first.dir).not.toBe(second.dir)
    expect(first.dir.startsWith(join(dir, 'tmp'))).toBe(true)
    expect(first.imagePath.startsWith(first.dir)).toBe(true)
    expect(first.imagePath).toMatch(/[0-9a-f]{16}\.png$/)

    writeFileSync(first.imagePath, makePng(5, 4))
    mkdirSync(join(first.dir, 'profile', 'Default'), { recursive: true })
    writeFileSync(join(first.dir, 'profile', 'Default', 'Cookies'), 'x')
    const info = await scratch.inspect(first.imagePath)
    expect(info.bytes).toBe(makePng(5, 4).length)
    expect(info.head.length).toBe(24)
    if (process.platform !== 'win32') {
      expect(statSync(first.imagePath).mode & 0o777).toBe(0o600)
      expect(statSync(first.dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, 'tmp')).mode & 0o777).toBe(0o700)
    }

    await scratch.dispose(first)
    await scratch.dispose(second)
    await scratch.dispose(second) // idempotent
    expect(readdirSync(join(dir, 'tmp'))).toEqual([])
  })

  test('inspecting a missing file rejects', async () => {
    const scratch = new FileCaptureScratch(dir, new MemoryLogger())
    const ws = await scratch.create()
    await expect(scratch.inspect(ws.imagePath)).rejects.toThrow()
    await scratch.dispose(ws)
  })
})
