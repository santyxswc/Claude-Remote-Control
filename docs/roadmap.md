# Roadmap

Derived from `docs/plan.md` ("Roadmap por fases" and "Flujos de fases posteriores"). Each phase has
a verifiable exit condition.

## Phases

| Phase | Flows | Deliverable | Moves on when | Status |
| --- | --- | --- | --- | --- |
| 0 · Technical proof | F0 | Minimal channel working | The three unknowns are answered in an ADR | Implemented. Unknowns answered from the docs in [ADR 0005](adr/0005-f0-findings.md); live confirmation pending |
| 1 · MVP | F1 to F6 | Remote control usable every day | You spend a day away from home without returning to the keyboard, with tests green | Implemented and covered by automated tests. Not yet validated live: see [flows/README.md](flows/README.md) |
| 2 · Publication | none new | Public repo with README, demo and `SECURITY.md` | Another person installs it on their PC following only the README | Docs done (README in English and Spanish, `SECURITY.md`, `CONTRIBUTING.md`, architecture, flow index, plugin skills). Pending: license, demo, and the plugin install route confirmed live |
| 3 · Productivity | F7 to F12 | Option buttons, git, status, files, charts and memory | A full session ends with an approved summary saved | Not started |
| 4 · Voice and multi-project | F13, F14 | Daemon and one topic per session | Two simultaneous sessions work without crossed messages | Not started |
| 5 · Mini App | F15 | Live screen inside Telegram | The tunnel passes a written security review | Not started |

The shared bot with a relay is not on the roadmap. If it is ever picked up, it starts with its own
threat analysis before any code ([ADR 0001](adr/0001-own-bot-per-user.md)).

## Later flows

Each one adds commands, MCP tools or an adapter without changing the core.

| Flow | What it does | Design key |
| --- | --- | --- |
| F7 · Options and skills | `/skills` lists the project's skills as buttons. An `ask_choice` tool lets Claude offer options as buttons | Choosing a button sends a normal instruction; it does not skip permissions |
| F8 · Git from the chat | `/diff` sends the diff as a file, with Commit, Revert and Open PR buttons | Each button is a predefined instruction that goes through the permission relay |
| F9 · Pinned status message | A pinned message shows the current task and pending items, edited live | Fed by hooks, not by Claude |
| F10 · Incoming images and files | A photo or file is saved to a temporary folder and reaches Claude as a path | Size limit and an allowlist of types |
| F11 · Charts | A `send_chart` tool takes a Vega-Lite spec and sends the PNG | No browser: Vega to SVG, then resvg to PNG |
| F12 · Summary and memory | On session close or `/wrap`, Claude summarizes into `docs/sessions/` and proposes lines for `CLAUDE.md` | Nothing enters `CLAUDE.md` without your approval by button |
| F13 · Voice notes | whisper.cpp transcribes locally; the bot shows the text and asks for confirmation | Confirming stops a transcription error from becoming a command |
| F14 · Multi-project | A daemon owns the bot. A group with topics has one topic per session | Routed by topic, always authenticated by sender |
| F15 · Live-screen Mini App | A button opens the Mini App with a stream of the app in development | Validates `initData` with HMAC, read-only, needs an optional HTTPS tunnel. It is the only flow that exposes the PC to the internet, so it is optional and last |

Other items called out in the docs and not scheduled: the `privacy: minimal` mode (notices without
code or paths), TOTP for high-risk approvals and an inactivity lock, `/status` showing the
hook-fed busy state, an XDG desktop portal capture strategy, and a `PlaywrightCapturer`.

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
  - whether `UserPromptSubmit` fires for turns started by channel messages ([F4](flows/F4.md)).
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
