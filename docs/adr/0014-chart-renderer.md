# ADR 0014: Charts drawn in a child process, from inline Vega-Lite, with no browser

- Status: Accepted
- Date: 2026-11-14

## Context

F11 adds `send_chart`: Claude passes a Vega-Lite spec and the owner gets a PNG in the chat. A
spec is data Claude writes, and Claude can be steered by what it reads, so the spec has to be
treated as hostile. A full Vega runtime can do three dangerous things with a hostile spec:

- **Load resources.** `data.url`, image marks and `href` make Vega's loader fetch over the
  network or read local files. The data would then be drawn into an image that skips redaction.
- **Run code.** Vega compiles expressions (`calculate`, `filter`, signals) to JavaScript with
  `Function` by default.
- **Take too long or too much.** A large `sequence`, a huge canvas or a deep spec can hang the
  process or exhaust memory.

The channel process must also start fast and stay responsive: `/stop` must never wait behind a
chart.

## Decision

1. **Pipeline without a browser.** Vega-Lite compiles the spec to Vega. `vega.parse` runs with
   `ast: true`. A `View` with `renderer: 'none'` and `vega-interpreter` evaluates the expressions,
   and `view.toSVG()` produces the SVG. `@resvg/resvg-wasm` rasterizes it to PNG with fonts
   bundled in the repository. No headless browser and no canvas package.
2. **A child process per chart.** `ProcessChartRenderer` starts `bun --smol
   src/adapters/chart/chartWorker.ts`:
   - The environment is empty: the bot token and no other channel variable is passed. On
     Windows Bun adds only the basic system variables (`PATH`, `SYSTEMROOT`, `TEMP`, ...);
     `TMPDIR`, `TEMP` and `TMP` point at the scratch directory.
   - The working directory is a fresh `<stateDir>/tmp/<random>` directory.
   - The spec arrives on stdin, the result is one JSON line on stdout (read up to 64 KiB), and
     stderr is discarded.
   - A 20 s deadline kills the process (`SIGKILL`, `TerminateProcess` on Windows), and so does
     the channel shutting down.
   - Only the worker imports the chart libraries, lazily: the channel never loads them. A test
     enforces both.
3. **Nothing is loaded.**
   - At validation (`checkChartSpec`, domain), any `url` or `href` key anywhere, image marks,
     `sequence`/`graticule` generators, full Vega specs and prototype keys are refused.
   - In the worker, the Vega loader is an object whose `load`, `sanitize`, `http` and `file` all
     reject. Any attempt fails the render (`invalid_spec`) even if Vega would have carried on.
     Tests run the worker on specs that skip validation (an http URL to a local `Bun.serve`
     counter, an absolute path, a `file:` URL, a relative URL resolved against the working
     directory, an image mark and a link) and see no request and no file read.
4. **No code from the spec.** Expressions are parsed to an AST and interpreted; codegen is never
   used. After the libraries load, the worker replaces `Function`, `eval`, `fetch`, `WebSocket`,
   `XMLHttpRequest` and the `constructor` of the function, async, generator and async generator
   prototypes with throwing stubs. A test passes five expressions that try to reach the
   `Function` constructor and write a marker file: the marker never appears. Vega's own
   expression parser refuses them first (`Illegal callee type`).
5. **resvg loads nothing.** The WebAssembly build has no file system or network access. It gets
   the SVG string and the two bundled font buffers; every generic family maps to the bundled
   Noto Sans, so text renders the same on every machine.
6. **Redaction before drawing.** Text drawn into pixels cannot be redacted afterwards, so
   `buildOutbound` wraps the renderer in `RedactingChartRenderer`. Every string in the spec, keys
   included, goes through the same `SecretRedactor` as text, before the worker sees it. The
   number of replacements is returned to Claude and audited. The caption goes through the image
   pipeline (redacted, fitted to 1024 characters).
7. **Limits.**

| Limit | Value | Where |
| --- | --- | --- |
| Spec size | 200,000 bytes of JSON | `MAX_CHART_SPEC_BYTES` |
| Inline rows (all `values` and `datasets`) | 5,000 | `MAX_CHART_DATA_VALUES` |
| Keys plus values in the spec | 60,000 | `MAX_CHART_NODES` |
| Nesting depth | 32 | `MAX_CHART_DEPTH` |
| One string or key | 2,000 characters | `MAX_CHART_STRING_LENGTH` |
| Chart side, laid out | 2,000 px (refused above) | `MAX_CHART_SIDE` |
| Output pixels | 12,000,000 (the 2x scale shrinks to fit) | `MAX_CHART_PIXELS`, `CHART_SCALE` |
| PNG size | 20,000,000 bytes, then Telegram's photo and document rules | `MAX_CHART_PNG_BYTES`, `chooseImageDelivery` |
| Wall time | 20 s, then killed | `CHART_RENDER_TIMEOUT_MS` |
| Charts at once | 1; another request gets `busy` | `SendChart` |
| Worker result | 64 KiB of stdout | `ProcessChartRenderer` |
| Caption | 1,024 characters | `MAX_CHART_CAPTION_LENGTH` |

8. **Audit.** `chart.sent` and `chart.not_sent` carry the chat id, the spec's size and row
   count, the outcome, and for a sent chart photo or document, bytes, width, height and the
   redaction count. They never carry the spec, the caption or the renderer's error message (it
   can quote the spec; only Claude gets it).

## Dependencies

All pinned to exact versions in `package.json`.

| Package | Version | Unpacked size | License | Why |
| --- | --- | --- | --- | --- |
| `vega-lite` | 6.5.0 | 7.1 MB | BSD-3-Clause | Compiles the Vega-Lite spec Claude writes. Vega-Lite is the format Claude knows best for charts |
| `vega` | 6.4.0 | 3.6 MB | BSD-3-Clause | Parses, lays out and draws the scenegraph to SVG with `renderer: 'none'` |
| `vega-interpreter` | 2.3.2 | 85 KB | BSD-3-Clause | Evaluates expressions from the AST, so no `Function` codegen runs (Vega's CSP-safe mode) |
| `@resvg/resvg-wasm` | 2.6.2 | 2.5 MB | MPL-2.0 | SVG to PNG in WebAssembly: one build for every OS, no native binaries, no file system or network access |

With their transitive dependencies (the `d3-*` and `vega-*` packages, `json-stringify-pretty-compact`
and others), 75 packages and about 20 MB are added to `node_modules`. The plugin runs
`bun install --production` on first start, so first start takes a little longer. The channel
itself does not load any of it.

`@resvg/resvg-js` (native) was rejected: it ships a native binary per platform and architecture,
and a native module runs with full process rights. `canvas`/`node-canvas` was rejected for the
same reason and its system libraries. A headless browser (as F5 uses for pages) is far heavier
and has far more attack surface.

### Fonts

`assets/fonts/NotoSans-Latin-Regular.ttf` (28,132 bytes) and `NotoSans-Latin-Bold.ttf` (28,208
bytes) are the Latin subsets of Noto Sans 5.3.0 from Fontsource (`latin-400-normal.ttf` and
`latin-700-normal.ttf`). They cover Basic Latin and Latin-1, so Spanish accents render. The
license is the SIL Open Font License 1.1 (`assets/fonts/OFL.txt`, "Copyright 2022 The Noto
Project Authors"), which allows bundling. `.gitattributes` marks `*.ttf` as binary. Characters
outside the subset (CJK, emoji) render as missing glyphs.

## Consequences

- A chart costs a process start: about 0.3 s on the development machine (Windows 11, Bun 1.4.4),
  of which about 170 ms is loading the libraries. That is fine for a tool called a few times
  a session.
- The renderer's guarantees do not depend on validation: both layers refuse external resources.
- Redacting the spec's strings can change the chart (a redacted category becomes `[REDACTED]`,
  two redacted values merge). Accepted: a secret must not reach an image.
- Residual: numbers are not redacted. A secret written as digits only, which the redactor does
  not recognize as text either, would be drawn. The image pipeline's caption already says images
  are not redacted.
- Residual: the worker is a process of the same user, not a sandbox. It receives no secrets and
  can load nothing, but a bug in Vega's or resvg's parsers would run with the user's rights
  until the deadline. The interpreter and the code-generation lock-down narrow that to memory
  corruption in the WebAssembly or JavaScript engine.

## Needs live verification

- That the photo arrives sharp and legible on the phone at the 2x scale.
- That Claude writes inline-data specs without being told twice (the tool description and the
  channel instructions say so).
- Process start time on the owner's Arch machine.
