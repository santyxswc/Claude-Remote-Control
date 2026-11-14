# ADR 0010: Page captures use the installed browser's headless mode, not Playwright

- Status: Accepted
- Date: 2026-11-14
- Sources (fetched 2026-11-14):
  - Chrome headless mode: <https://developer.chrome.com/docs/chromium/headless> ("Since Chrome
    132.0.6793.0 the old Headless mode is only available as a standalone binary named
    `chrome-headless-shell`"; Chrome now has "unified Headless and headful modes").
  - Chromium source, `main` branch, on chromium.googlesource.com:
    - `components/headless/command_handler/headless_command_switches.cc`: `screenshot`,
      `timeout`, `virtual-time-budget`.
    - `components/headless/command_handler/headless_command_handler.cc`: `--screenshot=[output
      path]` (default `screenshot.png`, `.png` supported), `--window-size=w,h` used for the
      screenshot size, `virtual-time-budget=[ms]`, `timeout=[ms]`.
    - `chrome/browser/headless/headless_mode_util.cc`: headless mode is
      `HasSwitch(switches::kHeadless)` (the value is ignored); `ui/gfx/switches.cc`:
      `kHeadless[] = "headless"`.
    - `content/public/common/content_switches.cc`: `disable-gpu`, `hide-scrollbars`.
    - `chrome/common/chrome_switches.h`: `user-data-dir`, `no-first-run`,
      `no-default-browser-check`, `disable-background-networking`, `disable-component-update`.
    - `base/command_line.cc`: `kSwitchTerminator = "--"`; switch parsing stops there, so later
      arguments are never switches.
  - Telegram Bot API 10.4 (`sendPhoto`, `sendDocument`): see `docs/flows/F5.md`.

## Context

The plan ("Stack tecnológico", F5 step 1) names Playwright for web captures. Playwright is an npm
dependency plus a browser download of a few hundred MB per platform (`playwright install`), and
the plugin installs its dependencies at startup (ADR 0009). The owner's main machine (Arch) and
most developer machines already have a Chromium-family browser, and every one of them can take a
screenshot without any driver: `chrome --headless --screenshot`.

## Decision

- `/shot <url>` and `send_screenshot` with `url` use `HeadlessBrowserCapturer`
  (`src/adapters/capture/`), which runs the installed Chromium, Chrome, Brave or Edge once per
  capture with an argument array, no shell and a 45 s hard timeout:

  ```
  <browser> --headless=new --disable-gpu --hide-scrollbars --no-first-run
            --no-default-browser-check --disable-background-networking --disable-component-update
            --user-data-dir=<stateDir>/tmp/<random>/profile --window-size=1280,800
            --virtual-time-budget=5000 --timeout=20000
            --screenshot=<stateDir>/tmp/<random>/<random>.png -- <url>
  ```

  `--headless=new` selects the new headless mode on Chrome 109-131 and is plain `--headless` on
  current versions, which ignore the value.
- **Discovery** (`discoverBrowser`, a pure function over an injected probe):
  `TELEGRAM_BRIDGE_BROWSER` (absolute path) wins; a value that is not an absolute path to a file
  disables page captures instead of silently falling back. Otherwise: `chromium`,
  `chromium-browser`, `google-chrome`, `google-chrome-stable`, `brave`, `brave-browser`,
  `microsoft-edge`, `microsoft-edge-stable` on `PATH` (Linux and other Unix); the standard install
  directories under `ProgramFiles`, `ProgramFiles(x86)` and `LOCALAPPDATA` (Windows);
  `/Applications` and `~/Applications` app bundles (macOS).
- **Isolation**: a throwaway `--user-data-dir` inside the capture's private directory, deleted
  with it, so a capture never sees the user's cookies, sessions or extensions, and never hands
  off to a running browser that uses the real profile.
- **The URL can never be a switch**: it is the last argument after `--`, and the URL policy only
  lets through normalized `http:`/`https:` URLs (which start with `http`).
- **The seam stays**: the use case depends on the `ScreenCapturer` port (GoF Strategy). A
  `PlaywrightCapturer` can be added later as another strategy without touching
  `CaptureScreenshot`.

## Consequences

- No new npm dependency and no browser download. Works the same on Arch, Windows and macOS with
  whatever browser is there, and on a headless Linux box (no display is needed).
- Less control than Playwright: no "wait for selector" or "network idle"; the page gets 5 s of
  virtual time and Chromium's 20 s load deadline. Pages that render later (long animations,
  websockets that never settle) may be captured early. Only the viewport is captured, not the
  full page.
- The result depends on the installed browser's version; a very old Chromium may ignore
  `--virtual-time-budget`.
- Without a Chromium-family browser page captures are unavailable; `/shot` says what to install
  or set. Firefox's own `--screenshot` is not supported.
- Killing the browser on timeout kills its main process; its helpers exit when their parent goes.
  The scratch directory is removed with retries afterwards.
