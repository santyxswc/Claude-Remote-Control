# Roadmap

Derived from `docs/plan.md` ("Roadmap por fases" and "Flujos de fases posteriores"). Each phase has
a verifiable exit condition.

## Phases

| Phase | Flows | Deliverable | Moves on when | Status |
| --- | --- | --- | --- | --- |
| 0 · Technical proof | F0 | Minimal channel working | The three unknowns are answered in an ADR | Implemented. Unknowns answered from the docs in [ADR 0005](adr/0005-f0-findings.md); live confirmation pending |
| 1 · MVP | F1 to F6 | Remote control usable every day | You spend a day away from home without returning to the keyboard, with tests green | Implemented and covered by automated tests. Not yet validated live: see [flows/README.md](flows/README.md) |
| 2 · Publication | none new | Public repo with README, demo and `SECURITY.md` | Another person installs it on their PC following only the README | Docs done (README in English and Spanish, `SECURITY.md`, `CONTRIBUTING.md`, architecture, flow index, plugin skills). Pending: license, demo, and the plugin install route confirmed live |
| 3 · Productivity | F7 to F12 | Option buttons, git, status, files, charts and memory | A full session ends with an approved summary saved | Implemented. F7 ([options and skills](flows/F7.md)), F8 ([git from the chat](flows/F8.md)), F9 ([pinned status](flows/F9.md)), F10 ([incoming files](flows/F10.md)), F11 ([charts](flows/F11.md)) and F12 ([summary and memory](flows/F12.md)) implemented with automated acceptance; live validation pending (the exit condition, a full session ending with an approved summary, needs a live run) |
| 4 · Voice and multi-project | F13, F14 | Voice notes, daemon and one topic per session | Two simultaneous sessions work without crossed messages | F13 ([voice notes](flows/F13.md)) implemented with automated acceptance; live validation pending. F14 not started |
| 5 · Mini App | F15 | Live screen inside Telegram | The tunnel passes a written security review | Not started |

The shared bot with a relay is not on the roadmap. If it is ever picked up, it starts with its own
threat analysis before any code ([ADR 0001](adr/0001-own-bot-per-user.md)).

## Later flows

Each one adds commands, MCP tools or an adapter without changing the core.

| Flow | What it does | Design key |
| --- | --- | --- |
| F7 · Options and skills | `/skills` lists the project's skills as buttons. An `ask_choice` tool lets Claude offer options as buttons | Choosing a button sends a normal instruction; it does not skip permissions. **Implemented** ([F7](flows/F7.md), [ADR 0011](adr/0011-choices-skills-and-attachments.md)) |
| F8 · Git from the chat | `/diff` sends the diff as a file, with Commit, Revert and Open PR buttons | Each button is a predefined instruction that goes through the permission relay. **Implemented** ([F8](flows/F8.md), [ADR 0012](adr/0012-read-only-git-adapter.md)): the bridge only reads, with hardened git invocations; the diff is redacted before it is capped |
| F9 · Pinned status message | A pinned message shows the current task and pending items, edited live | Fed by hooks, not by Claude. **Implemented** ([F9](flows/F9.md), [ADR 0013](adr/0013-status-fed-by-hooks.md)): `/pin` and `/unpin`, debounced edits on their own lane; no todo list (hooks do not reliably expose it) |
| F10 · Incoming images and files | A photo or file is saved to a temporary folder and reaches Claude as a path | Size limit and an allowlist of types. **Implemented** ([F10](flows/F10.md)): extension and magic-byte checks, a private per-session inbox with a 24 h TTL and a 200 MB quota |
| F11 · Charts | A `send_chart` tool takes a Vega-Lite spec and sends the PNG | No browser: Vega to SVG, then resvg to PNG. **Implemented** ([F11](flows/F11.md), [ADR 0014](adr/0014-chart-renderer.md)): inline data only, a child process with an empty environment, a refuse-all loader, the expression interpreter and a 20 s kill; strings redacted before drawing |
| F12 · Summary and memory | On session close or `/wrap`, Claude summarizes into `docs/sessions/` and proposes lines for `CLAUDE.md` | Nothing enters `CLAUDE.md` without your approval by button. **Implemented** ([F12](flows/F12.md), [ADR 0015](adr/0015-session-summary-and-memory.md)) for `/wrap` only: a `SessionEnd` hook cannot make Claude do work, so there is no automatic wrap. The bridge writes both files; Claude editing memory files directly is high risk |
| F13 · Voice notes | whisper.cpp transcribes locally; the bot shows the text and asks for confirmation | Confirming stops a transcription error from becoming a command. **Implemented** ([F13](flows/F13.md), [ADR 0016](adr/0016-voice-notes.md)): opt-in, ffmpeg plus `whisper-cli` with fixed argv and deadlines, the audio deleted at once, Send only when the text was shown unredacted, and a transcript never runs a bridge command or a verdict |
| F14 · Multi-project | A daemon owns the bot. A group with topics has one topic per session | Routed by topic, always authenticated by sender |
| F15 · Live-screen Mini App | A button opens the Mini App with a stream of the app in development | Validates `initData` with HMAC, read-only, needs an optional HTTPS tunnel. It is the only flow that exposes the PC to the internet, so it is optional and last |

Other items called out in the docs and not scheduled: the `privacy: minimal` mode (notices without
code or paths), TOTP for high-risk approvals and an inactivity lock, `/status` showing the
hook-fed busy state, an XDG desktop portal capture strategy, a `PlaywrightCapturer`, listing
plugin skills in `/skills`, audio files and round videos (F13 covers voice notes only), and a
`/status` line for voice notes.

## Open decisions (need the owner)

- [ ] **License.** MIT or Apache-2.0. No LICENSE file exists and the README says "to be decided".
  `claude plugin validate .` also reports the missing license under its directory checks.
- [ ] **Project name and repository name.** The package and plugin are called `telegram-bridge`
  (skills will be `/telegram-bridge:init` and so on, not `/bridge:init` as in the plan). The GitHub
  repository is named `Claude-Remote-Control`.
- [ ] **Live verification items from [ADR 0005](adr/0005-f0-findings.md)** and the later ADRs:
  - one channel process per session, and behaviour on `/mcp` reconnect and `--resume`;
  - the exact effect of `continue: false` from `PreToolUse` on a turn in flight;
  - whether Escape via `tmux send-keys` interrupts like a real keypress, and what it does at an idle
    prompt;
  - the plugin items of [ADR 0009](adr/0009-plugin-layout.md) (the plugin server replacing the
    `.mcp.json` entry, `${VAR:-}` in plugin server `env`, the plugin-scoped tool name, the
    `--channels plugin:telegram-bridge@<marketplace>` form, async hooks on Windows);
  - that an older Claude Code ignores the `onFailure` key ([ADR 0003](adr/0003-stop-via-hook.md));
  - the minimum Claude Code version for channels;
  - whether `UserPromptSubmit` fires for turns started by channel messages ([F4](flows/F4.md));
  - whether a slash command inside a channel event runs as a command, and how Claude acts on
    "Use the skill /name" ([F7](flows/F7.md));
  - real photo sizes, album delivery and `getFile` on real files ([F10](flows/F10.md));
  - how Claude carries out the `/diff` button instructions, and how the document shows on the
    phone ([F8](flows/F8.md));
  - that the pinned status's send, pin and edits never notify, and how often edits hit 429
    ([F9](flows/F9.md));
  - chart legibility on the phone and render time on the owner's machine ([F11](flows/F11.md));
  - how Claude follows `/wrap` (both tools, the right `chat_id`) and the `kind="memory"`
    outcome ([F12](flows/F12.md));
  - real `whisper-cli` and `ffmpeg` on each OS, transcription times, the Windows binaries
    ([F13](flows/F13.md)).
- [ ] **Plugin distribution.** The repository has no `marketplace.json`; decide whether to add one
  (a marketplace entry would make `/plugin install` possible). It would still need the
  development-channel flag, since only `claude-plugins-official` and an organization's
  `allowedChannelPlugins` are on the channel allowlist. `claude plugin validate .` suggests the
  one-step form `/plugin install telegram-bridge --marketplace <owner>/<repo>` (Claude Code 2.1.275
  or later); that is the validator's advice, not yet tried here.
- [ ] **Demo.** Record it after live validation.
- [ ] **Wayland or X11 on the owner's Arch machine**, to confirm which native capture tool works
  ([F5](flows/F5.md)).
- [ ] **Plugin metadata.** `claude plugin validate` warns about a missing `author` and icon.
