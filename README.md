# telegram-bridge

[Leer en español](README.es.md)

A Claude Code channel that turns a Telegram chat into a remote control for a Claude Code session
running on your own PC.

Claude Code stops when a task ends or when it asks for a permission, and nothing happens until
someone returns to the keyboard. `telegram-bridge` lets you give instructions, answer permission
prompts, get "finished" notices, look at the screen and stop Claude from your phone. You create
and own the bot, and everything runs on your PC: there is no shared bot and no server operated by
this project ([ADR 0001](docs/adr/0001-own-bot-per-user.md)).

## Status

The MVP (flows F0 to F6), the six phase-3 flows (F7 options and skills, F8 git from the chat, F9
pinned status, F10 incoming files, F11 charts, F12 session summary and memory) and F13 voice notes are implemented and covered by automated tests that use fakes for Telegram
and for Claude Code, plus two local smoke tests for screenshots. It has **not yet been validated
end to end against the real Telegram API or a live Claude Code session**. Several behaviours of
Claude Code are marked "needs live verification" in the docs. The checklist for that validation
is in [docs/flows/README.md](docs/flows/README.md). Treat this as pre-release software.

Channels are a research preview of Claude Code: the flag and the protocol can change.

A demo will be added after live validation.

License: [MIT](LICENSE). The bundled Noto Sans fonts are under the SIL Open Font License 1.1 (`assets/fonts/OFL.txt`).

## What it does

The MVP has six capabilities:

1. **Two-way messages.** Text you send to the bot reaches the session; Claude answers with a `reply`
   tool. Outgoing text is redacted for secrets and split to fit Telegram's 4096-character limit
   ([F2](docs/flows/F2.md)).
2. **Permission prompts with buttons.** Tool approval dialogs are relayed to the chat with Approve and
   Deny buttons. Destructive-looking requests need a second tap. The terminal dialog stays open and
   whichever answer arrives first wins ([F3](docs/flows/F3.md)).
3. **Finished and needs-answer notices.** Claude Code hooks tell the chat when Claude finished or is
   waiting for you, without Claude having to call a tool ([F4](docs/flows/F4.md)).
4. **Screenshots on demand.** `/shot` captures the screen and `/shot <url>` captures a web page. Claude
   can also send one with a tool ([F5](docs/flows/F5.md)).
5. **Panic button.** `/stop` makes a `PreToolUse` hook refuse every tool call until `/resume`
   ([F6](docs/flows/F6.md)).
6. **Secure pairing.** A one-time code, shown as a QR code in your terminal, links your Telegram
   account to the PC; you confirm the claimant at the terminal. Everyone else is ignored
   ([F1](docs/flows/F1.md)).

Since the MVP:

7. **Options as buttons and `/skills`.** An `ask_choice` tool lets Claude ask a multiple-choice
   question; your tap comes back as a normal message, never as an approval. `/skills` lists the
   project's and your personal skills as buttons; a tap asks Claude to use one
   ([F7](docs/flows/F7.md)).
8. **Photos and files.** Send a photo or a document (images, PDF, text and source files) and Claude
   gets the path of a private local copy. Types are checked by extension and content, the limit is
   20 MB, and files are deleted after 24 hours ([F10](docs/flows/F10.md)).
9. **Git from the chat.** `/diff` sends a summary and the uncommitted changes as a redacted
   `.diff` file. Commit, Revert and Open PR buttons each send Claude a fixed instruction, and
   Claude still asks permission for every command. The bridge itself only reads the repository,
   with git hardened against repository configuration that runs programs ([F8](docs/flows/F8.md)).
10. **Pinned status message.** `/pin` pins a message that shows the session's state, its last
    tool, and pending approvals and questions, edited in place from hook events and never written
    by Claude. `/unpin` removes it ([F9](docs/flows/F9.md)).
11. **Charts.** A `send_chart` tool turns a Vega-Lite spec with inline data into a PNG photo.
    There is no browser: it is drawn in a short-lived child process that cannot load URLs or
    files and is killed after 20 seconds; text in the chart is redacted before drawing
    ([F11](docs/flows/F11.md)).
12. **Session summary and memory.** `/wrap` asks Claude to summarize the session, which the
    bridge saves to `docs/sessions/` and sends to the chat, and to propose lines for
    `CLAUDE.md`. You approve or reject them with a button; only approved lines are written, by
    the bridge, under `## Session notes` ([F12](docs/flows/F12.md)).
13. **Voice notes** (optional). A voice note is transcribed on your PC by whisper.cpp; you see
    the exact text with Send and Discard, and only Send passes it to Claude, as if typed. The
    audio is deleted right away and never leaves the PC. Off until you install `whisper-cli`
    and ffmpeg and set `TELEGRAM_BRIDGE_WHISPER_MODEL` ([F13](docs/flows/F13.md)).

Not done yet (see [docs/roadmap.md](docs/roadmap.md)): one topic per project and the live-screen Mini App. Answering Telegram
calls is out of scope: the Bot API does not allow it.

The MVP is one bot for one Claude Code session.

## Requirements

- Claude Code, signed in with a claude.ai account or a Console API key. Channels are not available
  on Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry. On Team and Enterprise
  plans an admin must enable channels (`channelsEnabled`). Version: 2.1.295 or later is
  recommended, because the brake hook uses the `onFailure` key ([ADR 0003](docs/adr/0003-stop-via-hook.md));
  permission relay needs 2.1.234 or later. The exact minimum version for channels is **to be
  confirmed in live validation**.
- [Bun](https://bun.sh) (the channel, the hooks and the CLI are Bun scripts). CI uses 1.4.4. Arch Linux: `sudo pacman -S bun`.
- A Telegram account with two-step verification enabled (Settings, Privacy and Security,
  Two-Step Verification). Whoever takes over your account can approve tool use on your PC.
- An interactive Claude Code session. The development-channel flag is ignored with `-p`.

Platforms: Windows, Linux and macOS are targets. CI runs the automated tests on Ubuntu and Windows.
The two screenshot smoke tests were run on one Windows machine; nothing has been run by hand on
Linux or macOS yet (tmux, Wayland and X11 capture, Unix sockets are covered only by tests and by
reading the docs).

Optional tools:

| Tool | Used for | Notes |
| --- | --- | --- |
| git | `/diff` and the git line of `/status` | Found on `PATH` at startup. Only read-only commands run ([ADR 0012](docs/adr/0012-read-only-git-adapter.md)). |
| tmux | `/stop` also sends Escape to interrupt the running turn | Linux and macOS only, and only if Claude Code runs inside a tmux pane. Without it `/stop` blocks the next tool call. Windows has no equivalent. |
| A Chromium-family browser (Chromium, Chrome, Brave, Edge) | `/shot <url>` | Found on `PATH` or in standard install locations; or set `TELEGRAM_BRIDGE_BROWSER`. Runs headless with a throwaway profile ([ADR 0010](docs/adr/0010-headless-browser-instead-of-playwright.md)). |
| Linux, Wayland: `grim`, `spectacle` or `gnome-screenshot` | `/shot` (screen) | Tried in that order. |
| Linux, X11: `maim`, `scrot` or ImageMagick `import` | `/shot` (screen) | Tried in that order. |
| macOS | `/shot` (screen) | Uses the built-in `screencapture`. |
| Windows | `/shot` (screen) | Uses the built-in Windows PowerShell; captures every monitor. |
| whisper.cpp (`whisper-cli`), ffmpeg and a ggml model | Voice notes | Off until `TELEGRAM_BRIDGE_WHISPER_MODEL` is set. Arch: `pacman -S whisper-cpp ffmpeg`; macOS: `brew install whisper.cpp ffmpeg`; others and Windows: [F13](docs/flows/F13.md#setup). ffmpeg is required: whisper.cpp does not read Opus. |

On Linux the channel must run inside the graphical session to capture the screen. Page captures
need no display.

## Installation

Language note: bot replies and CLI output are in **Spanish by default**. Set
`TELEGRAM_BRIDGE_LOCALE=en` for English.

**1. Create a bot.** In Telegram open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a
name and a username ending in `bot`, and keep the token it returns. Treat the token as a password.

**2. Get the code.**

```bash
git clone https://github.com/santyxswc/Claude-Remote-Control
cd Claude-Remote-Control
bun install
```

**3. Configure the bot.** The command asks for the token without echoing it (or reads it from stdin
with `--token-stdin`), checks it with Telegram and stores it in the state directory with owner-only
permissions. It never accepts the token as an argument.

```bash
bun run bridge -- init
```

**4. Pair your account.** The terminal shows a QR code and a `t.me` link that expire in 120 seconds.
Open it on your phone and press Start. The terminal then shows the name, username and numeric id of
whoever sent the code; type `s` (Spanish) or `y` (English) only if it is you.

```bash
bun run bridge -- pair
```

**5. Start Claude Code with the channel flag.** Choose one way to run it.

*A. Development checkout (the repo's `.mcp.json`).* Run Claude Code in the checkout directory. The
server is registered by `.mcp.json`; it only receives messages when named in the flag:

```bash
claude --dangerously-load-development-channels server:telegram-bridge
```

Claude Code shows a full-screen development-channels warning (choose "I am using this for local
development") and, the first time, asks you to approve the project's MCP server. To use the bridge
from another project, add the server to your user-level MCP configuration with an absolute path
(see the [channels reference](https://code.claude.com/docs/en/channels-reference)). In both cases
the notice hooks and the brake are not active until you add them to your settings: use the
snippet in [docs/flows/F4.md](docs/flows/F4.md#for-people-not-using-the-plugin) with the absolute
path of your checkout. Without the hooks there are no "finished" notices and `/stop` cannot block
tool calls.

*B. As a plugin.* The repository is also the plugin ([ADR 0009](docs/adr/0009-plugin-layout.md)):
its manifest declares the server and `hooks/hooks.json` registers the hooks. The documented way to
load a plugin from a directory for one session is:

```bash
claude --plugin-dir /path/to/Claude-Remote-Control
```

The channel flag for a plugin has the form `plugin:<name>@<marketplace>`. What `<marketplace>` is
for a plugin loaded with `--plugin-dir`, and the full command, are **to be confirmed in live
validation**. The repository does not ship a `marketplace.json` yet, so there is no
`/plugin install` route today. At the first start the plugin runs `bun install --production`,
which takes several seconds.

Also in both cases: allow the `reply` tool once, or every answer will open a permission prompt
that is itself relayed to your phone. See [Security](#security) and
[docs/flows/F3.md](docs/flows/F3.md#the-reply-tool-needs-its-own-permission).

When it works, the channel's log says `telegram polling started`. Claude Code keeps a channel's
stderr only during startup, so set `TELEGRAM_BRIDGE_LOG_FILE` to see it (see
[Configuration](#configuration)). Send `/status` to the bot to check. The step-by-step first run is in
[docs/flows/README.md](docs/flows/README.md).

The CLI is run from a checkout (`bun run bridge -- <command>`). It uses the same state directory
as the channel, so it works for both ways of running. Running the CLI from an installed plugin's
directory is **to be confirmed in live validation**.

## Chat commands

Sent to the bot from a paired account in a private chat. Anything else, including unknown
`/commands`, is forwarded to Claude as text.

| Command | What it does |
| --- | --- |
| `/start` | Checks that the bridge is connected. |
| `/help` | Lists the commands. |
| `/status` | Bot, paired since, MCP connection, pending permission requests, brake state, available screenshot kinds, received files kept, and a git line (branch, ahead/behind, changed files). |
| `/stop [reason]` | Engages the brake, denies pending permission requests and, inside tmux on Linux or macOS, sends Escape. |
| `/resume` | Releases the brake. Claude does not restart by itself. |
| `/shot` | Screenshot of the screen. |
| `/shot <url>` | Screenshot of an `http`/`https` page, for example `/shot localhost:3000`. |
| `/skills` | Lists the project's and your personal skills as buttons; a tap sends "Use the skill /name" to Claude. |
| `/diff [path]` | Sends the uncommitted changes (staged, unstaged, untracked list) as a redacted `.diff` file, with Commit, Revert and Open PR buttons. Works while braked. |
| `/pin` | Pins a status message that follows the session (state, last tool, pending items). Off until you send it. |
| `/unpin` | Removes the pinned status message and stops updating it. |
| `/wrap` | Asks Claude to save a session summary in `docs/sessions/` and to propose lines for `CLAUDE.md`, which you approve with buttons. Sends nothing while braked. |

Permission prompts also accept `yes <id>` or `no <id>` as text (the id is shown in the prompt);
high-risk requests can only be approved with the buttons.

Photos and documents are saved and forwarded as a path ([F10](docs/flows/F10.md)); voice notes are
transcribed and confirmed when configured ([F13](docs/flows/F13.md)); audio files, video
and stickers are refused with a notice. When Claude asks with `ask_choice`, tap an option, or tap
"Other…" and type your answer as the next message.

## CLI commands

Run as `bun run bridge -- <command>` from the checkout. Exit codes: 0 success, 1 failure, 2 usage.

| Command | What it does |
| --- | --- |
| `init [--token-stdin]` | Validates and stores the BotFather token. |
| `pair` | Starts pairing with a QR code and a one-time code. |
| `access list` | Lists allowed Telegram accounts. |
| `access revoke <id>` | Removes an account's access. |
| `stop [reason]` | Engages the brake from the terminal. |
| `resume` | Releases the brake. |
| `--help` | Shows usage. |

## Configuration

All settings are optional environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BRIDGE_HOME` | `<CLAUDE_CONFIG_DIR or ~/.claude>/channels/telegram-bridge` | State directory (token, database, flags). Use a throwaway one for first tests. Must be absolute or start with `~/`: a relative value is refused (the CLI fails, the channel serves MCP without Telegram, the brake hook uses the default directory), never resolved against the working directory. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Base of the default state directory. Same rule: absolute or `~/`. |
| `TELEGRAM_BOT_TOKEN` | unset | Overrides the token stored by `init`. The file is the recommended storage. |
| `TELEGRAM_BRIDGE_LOCALE` | `es` | `en` for English. |
| `TELEGRAM_BRIDGE_BROWSER` | auto-detected | Absolute path of the browser used for `/shot <url>`. An invalid value disables page captures. |
| `TELEGRAM_BRIDGE_MAX_UPLOAD_MB` | `20` | Largest incoming file, in whole MB from 1 to 20 (20 is the Bot API download limit; it can only be lowered). Anything else is logged and 20 is used. |
| `TELEGRAM_BRIDGE_WHISPER_MODEL` | unset | Absolute path of a ggml whisper model. Unset: voice notes are off (the bot says how to turn them on). |
| `TELEGRAM_BRIDGE_WHISPER` | `whisper-cli` on `PATH` | Absolute path of `whisper-cli`. A relative or missing path is refused. |
| `TELEGRAM_BRIDGE_WHISPER_LANGUAGE` | `auto` | Spoken language for whisper (`es`, `en`, ...); anything else falls back to `auto`. |
| `TELEGRAM_BRIDGE_FFMPEG` | `ffmpeg` on `PATH` | Absolute path of `ffmpeg`, which converts the note (Opus) for whisper. |
| `CLAUDE_PROJECT_DIR` | set by Claude Code | The project whose `.claude/skills` `/skills` lists. When it is unset or relative, the working directory is used if it has `.claude/` or `.git`; otherwise only personal skills are listed. `/diff` and the pinned status use it too (else the working directory). |
| `TELEGRAM_BRIDGE_DEBUG` | unset | `1` prints diagnostics on stderr from the hook scripts. |
| `TELEGRAM_BRIDGE_LOG_FILE` | unset | Absolute path of a file that also receives the channel's diagnostic log (owner-only, appended, never rotated). Claude Code keeps a channel's stderr only until the MCP connection is up, so lines such as `telegram polling started` appear nowhere else, even with `--debug`. Sender ids appear in it; message text and secrets do not. A relative path is refused. |
| `TELEGRAM_BRIDGE_DEV_PORT` | unset | Development only, without a bot: a local HTTP listener (F0) that needs the bearer token it keeps in `<stateDir>/dev-token`, refuses browser requests (`Origin`, foreign `Host`), and does not start when a bot token is configured. Leave it unset. |

The hooks, the CLI and the channel must resolve the same state directory, so set these variables
the same way for all of them (they inherit Claude Code's environment).

## Security

Read this before using it.

- **Whoever controls the bot or your Telegram account controls your PC.** They can send prompts to
  Claude and approve tool use. Enable Telegram two-step verification and keep the bot token secret.
  Revoke a leaked token in BotFather.
- **Bot chats are not end to end encrypted.** Telegram can read everything the bridge sends,
  including code, paths and command output.
- **Redaction is best effort.** It catches known credential shapes and the values in the project's
  `.env` files, not every secret. Text you send to Claude is not redacted.
- **Screenshots bypass redaction.** Whatever is on screen or on the page reaches Telegram as pixels.
  Every image says so in its caption.
- **Files you send are untrusted content for Claude.** A PDF or text file can contain instructions
  aimed at Claude (prompt injection), just as pasted text can. The bridge checks types and sizes,
  never runs files, and Claude reads them only with its normal, permission-checked tools.
- **A choice button is only an answer.** It sends text to Claude; it never approves a tool call.
- **`/diff` sends code off the PC.** The file is redacted, but only recognizable secrets are caught.
  The Commit, Revert and Open PR buttons are instructions, not approvals: Claude asks before each
  command.
- **Charts are images.** Strings in the spec are redacted before drawing, but numbers are not,
  and the rest of the image bypasses redaction like a screenshot. The renderer cannot load URLs
  or files.
- **`CLAUDE.md` changes only with your tap.** `propose_memory` shows every line; a line that
  redaction would change is refused. Claude editing `CLAUDE.md`, `AGENTS.md` or `.claude/`
  directly is a high-risk permission prompt. The saved session summary is a local file and is not
  redacted (its chat copy is).
- **Voice notes are confirmed text.** Transcription runs on your PC; the audio is deleted at
  once and never sent anywhere. Claude only gets the text you saw and sent, and a transcript
  never runs a bridge command or answers a permission prompt. A transcript the chat would
  redact cannot be sent. ffmpeg and whisper.cpp parse the audio without a sandbox.
- **The pinned status is activity metadata.** Project name, tool names, file names and command
  descriptions sit in a chat Telegram can read. It is off until `/pin`.
- **Never use `--dangerously-skip-permissions` with this.** The permission relay exists so you do
  not need it.
- **The development-channel flag.** A custom channel is not on Anthropic's approved list, so it
  runs only with `--dangerously-load-development-channels`, which skips the allowlist after a
  confirmation prompt. Only load code you trust; this flag is why the prompt says "dangerously".
- **Allow the reply tool, nothing broader.** Add `mcp__telegram-bridge__reply` to the allow rules of
  your Claude Code settings (as a plugin the name has the form `mcp__plugin_<plugin>_<server>__reply`;
  check it with `/permissions`). Do not pre-allow `send_screenshot`: each capture should stay a
  decision. `ask_choice`, `send_chart`, `save_session_summary` and `propose_memory` only post to your own chat (and the last two write `docs/sessions/` or, after your tap, `CLAUDE.md`); allowing them is your call. Details: [docs/flows/F3.md](docs/flows/F3.md#the-reply-tool-needs-its-own-permission).
- Strangers get no reply and no event. Only private chats from allowlisted user ids are accepted.

Full model and known limits: [docs/threat-model.md](docs/threat-model.md) and [SECURITY.md](SECURITY.md).

## Troubleshooting

- **409 Conflict, or "another process is polling".** Telegram serves one poller per bot. Close other
  Claude Code sessions that use the bridge, other programs using the same token (another machine,
  another Telegram plugin) and orphaned `bun` processes. The bridge never kills other processes; a
  crashed holder frees the lock within 60 seconds ([ADR 0006](docs/adr/0006-single-poller-lock.md)).
- **"Not configured".** The channel logs that Telegram is not configured, and the CLI says to run
  `init` first. Run `bun run bridge -- init`, then `pair`, with the same `TELEGRAM_BRIDGE_HOME` as the
  channel.
- **Messages do not reach Claude.** Claude Code drops channel events silently unless the server is
  named in the channel flag. Check the flag and `/mcp`. Also check that your account is paired
  (`access list`).
- **The brake is engaged.** `/status` shows it and chat messages are not forwarded. Send `/resume`,
  run `bun run bridge -- resume`, or delete `brake.json` in the state directory. A corrupt
  `brake.json` also blocks.
- **Hooks not firing (no "finished" notice, buttons stay after answering at the terminal).** Hooks
  must be loaded (the plugin, or the settings snippet) and resolve the same state directory.
  Only the process that polls Telegram listens for them, and the channel logs `listening for hook
  events`. Run Claude Code with `TELEGRAM_BRIDGE_DEBUG=1` to see why a hook gave up. `bun` must be on
  `PATH`.
- **`/shot` has no capture tool.** The reply names what to install (see the optional tools table).
  `/status` shows which kinds are available. On Linux the channel must run inside the desktop
  session; after installing a tool, restart the session.
- **A file was refused.** The notice gives the reason. Only the types in
  [F10](docs/flows/F10.md#allowlist) are accepted and the content must match the extension; the
  limit is 20 MB (or `TELEGRAM_BRIDGE_MAX_UPLOAD_MB`). Received files are kept in
  `<state dir>/inbox/` for 24 hours.
- **A voice note is refused.** The reply names the missing setting or the reason. Notes are
  limited to 3 minutes and 2 MB; the transcript must fit one message. Setup per OS:
  [F13](docs/flows/F13.md#setup).
- **`/diff` says the directory is not a git work tree.** It reads `CLAUDE_PROJECT_DIR`, else the
  directory Claude Code started in. "A filter the bridge cannot disable safely" means the
  repository configuration has a filter driver whose name contains `=` or a line break (or a
  filter list too long to read).
- **The pinned status says "unknown".** No hook events have arrived: install the plugin (or the
  hooks snippet of [F4](docs/flows/F4.md)).
- **`/skills` shows nothing from the project.** Claude Code sets `CLAUDE_PROJECT_DIR`; started
  some other way, the channel must run in the project directory. Plugin skills are not listed.

## How it works

Claude Code starts the channel (`src/main.ts`) as an MCP server over stdio. The channel long-polls
Telegram, passes each message through a chain of checks (private chat, pairing, allowlist, rate
limit, supported content, permission verdicts, commands, brake) and forwards what survives to the session
as a channel notification. Everything sent back goes through redaction and chunking. Hooks run as
short processes inside Claude Code and talk to the channel over a local Unix socket or named pipe;
the brake hook reads a flag file. State lives in SQLite and a few files in the state directory.
See [docs/architecture.md](docs/architecture.md).

## Development

```bash
bun install
bun run check   # lint, typecheck, architecture rules and tests (what CI runs)
```

Layout: `src/domain` (pure rules), `src/application` (ports and use cases), `src/adapters`
(Telegram, MCP, SQLite, capture, chart, project files, git, IPC, session), `src/composition` and the four entrypoints
(`main.ts`, `cli.ts`, `hook.ts`, `brakeHook.ts`), `hooks/`, `skills/`, `tests/`, `docs/`. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md).

## Documentation

- [docs/architecture.md](docs/architecture.md): layers, ports, processes, patterns, state files
- [docs/flows/README.md](docs/flows/README.md): flow index and the live-validation checklist
- [docs/validacion-en-vivo-prompt.md](docs/validacion-en-vivo-prompt.md): a prompt (in Spanish) for running the live validation with Claude Code
- [docs/threat-model.md](docs/threat-model.md) and [SECURITY.md](SECURITY.md)
- [docs/adr/](docs/adr/): decisions and findings about the Claude Code contract
- [docs/roadmap.md](docs/roadmap.md): phases and open decisions
- [docs/plan.md](docs/plan.md): the original design (Spanish)
