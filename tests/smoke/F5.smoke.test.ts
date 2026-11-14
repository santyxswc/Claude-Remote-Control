/**
 * Real captures on this machine, never in CI: skipped unless
 * `TELEGRAM_BRIDGE_SMOKE=1`. They start the installed browser (or the
 * native tool), check the PNG and remove everything they produced.
 *
 *   TELEGRAM_BRIDGE_SMOKE=1 bun test tests/smoke
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createScreenCapturers } from '../../src/adapters/capture/createScreenCapturers.ts'
import { discoverBrowser } from '../../src/adapters/capture/discoverBrowser.ts'
import { FileCaptureScratch } from '../../src/adapters/capture/FileCaptureScratch.ts'
import { HeadlessBrowserCapturer } from '../../src/adapters/capture/HeadlessBrowserCapturer.ts'
import { systemProbe } from '../../src/adapters/capture/systemProbe.ts'
import { spawnProcess } from '../../src/adapters/session/processRunner.ts'
import { parseCaptureUrl } from '../../src/domain/capture/captureUrl.ts'
import { readPngSize } from '../../src/domain/capture/pngSize.ts'
import { MemoryLogger } from '../fakes.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

const SMOKE_ENV = 'TELEGRAM_BRIDGE_SMOKE'
const SMOKE = process.env[SMOKE_ENV] === '1'

describe.skipIf(!SMOKE)('F5 smoke (real programs)', () => {
  test('headless capture of a page served on 127.0.0.1', async () => {
    const browser = discoverBrowser({
      platform: process.platform,
      env: process.env,
      homeDir: homedir(),
      probe: systemProbe,
    })
    if (!browser.found) throw new Error(`no browser: ${browser.reason}`)
    const site = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response('<h1 style="font:48px sans-serif">telegram-bridge smoke</h1>', {
          headers: { 'content-type': 'text/html' },
        }),
    })
    const dir = makeTempDir()
    const scratch = new FileCaptureScratch(dir, new MemoryLogger())
    const workspace = await scratch.create()
    try {
      const parsed = parseCaptureUrl(`127.0.0.1:${site.port}`)
      if (!parsed.ok) throw new Error('bad url')
      const capturer = new HeadlessBrowserCapturer({
        browser: browser.path,
        run: spawnProcess,
        logger: new MemoryLogger(),
      })
      const started = performance.now()
      const image = await capturer.capture(parsed.target, workspace)
      const ms = Math.round(performance.now() - started)
      const info = await scratch.inspect(image.path)
      const size = readPngSize(info.head)
      console.log(
        `[smoke] ${browser.path}: ${info.bytes} bytes, ${size?.width}x${size?.height}, ${ms} ms`,
      )
      expect(size).toEqual({ width: 1280, height: 800 })
      expect(info.bytes).toBeGreaterThan(1000)
    } finally {
      await scratch.dispose(workspace)
      expect(existsSync(workspace.dir)).toBe(false)
      await site.stop(true)
      removeTempDir(dir)
    }
  }, 60_000)

  test.skipIf(process.platform !== 'win32')(
    'native Windows screen capture',
    async () => {
      const setup = createScreenCapturers({
        platform: process.platform,
        env: process.env,
        homeDir: homedir(),
        probe: systemProbe,
        run: spawnProcess,
        logger: new MemoryLogger(),
      })
      const screen = setup.capturers.find((c) => c.kinds.includes('screen'))
      if (screen === undefined) throw new Error('no screen capturer')
      const dir = makeTempDir()
      const scratch = new FileCaptureScratch(dir, new MemoryLogger())
      const workspace = await scratch.create()
      try {
        const started = performance.now()
        const image = await screen.capture({ kind: 'screen' }, workspace)
        const ms = Math.round(performance.now() - started)
        const info = await scratch.inspect(image.path)
        const size = readPngSize(info.head)
        console.log(
          `[smoke] PowerShell: ${info.bytes} bytes, ${size?.width}x${size?.height}, ${ms} ms`,
        )
        expect(size?.width).toBeGreaterThan(0)
      } finally {
        await scratch.dispose(workspace)
        expect(existsSync(workspace.dir)).toBe(false)
        removeTempDir(dir)
      }
    },
    60_000,
  )
})
