# Security policy

`telegram-bridge` lets a Telegram chat drive a Claude Code session on your PC. Whoever controls
the bot or your Telegram account controls that PC, so security reports are taken seriously.

## Supported versions

The project is pre-1.0 and has no releases yet. Only the `main` branch is supported: fixes land
there and are not backported.

## Reporting a vulnerability

Please report privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting for this repository: open the repository's
**Security** tab and choose **Report a vulnerability** (a private security advisory). If that option
is not shown, open a public issue that says only that you want to report a security problem,
without details, and a private channel will be arranged there.

Include what you can: the affected file or flow, the steps to reproduce, the impact and the
version or commit. Do not include real bot tokens, pairing codes or other people's data. If you
found a leaked token in the repository history, revoke it first.

There is no guaranteed response time: this is a personal project. Reports are handled on a best
effort basis.

## In scope

- Anything that lets someone other than the paired owner send input to the session, approve or
  deny a permission, trigger `/stop`, `/resume` or `/shot`, or receive output from the bridge.
- Bypasses of the allowlist, of pairing (code guessing, replay, confirmation without the terminal)
  or of the brake hook.
- Secrets (bot token, pairing codes, the hook key) written to logs, the audit log, errors or
  messages.
- Weaknesses in the local IPC between the hooks and the channel, in file permissions of the
  state directory, or in how the capture tools and the browser are launched (argument injection,
  leftover files).
- A flaw that lets the redaction pipeline be skipped for text, prompts or images.

## Out of scope

- Problems that need control of the owner's Telegram account or bot token. This is the documented
  trust boundary; two-step verification and token hygiene are the owner's responsibility.
- Telegram being able to read bot chats (bot chats are not end-to-end encrypted).
- Secrets that redaction cannot recognize, and what appears in screenshots. Both are documented
  limits.
- Anything that needs another process already running as the same user on the PC (it can read the
  state directory anyway), and Windows pipe name squatting on a multi-user PC (accepted in
  [ADR 0008](docs/adr/0008-hook-ipc-transport.md)).
- Vulnerabilities in Claude Code, Telegram, Bun or other dependencies. Report those upstream.
- Running with `TELEGRAM_BRIDGE_DEV_PORT` set, which is a development-only, unauthenticated
  listener.

## Security model in short

- Each user runs their own bot; there is no shared relay ([ADR 0001](docs/adr/0001-own-bot-per-user.md)).
- Access is an allowlist of Telegram user ids (`from.id`, never the chat id), private chats only.
  Everyone else is dropped silently.
- Pairing uses a 128-bit one-time code valid for 120 seconds, generated locally, stored only as a
  hash, compared in constant time, and confirmed by a person at the terminal.
- The bot token lives in an owner-only file and is never accepted as a CLI argument or logged.
- Outgoing text, permission prompts and image captions are redacted before they leave. The `reply`
  tool refuses any chat that is not an allowlisted private chat.
- Permission relay shows plain text, one verdict per request, and asks for a second tap on risky
  patterns.
- `/stop` writes a brake flag that a synchronous `PreToolUse` hook enforces.
- Hooks talk to the channel over a local Unix socket or named pipe, with an HMAC on every frame;
  never over the network.
- An append-only audit log records security-relevant events without message text or secrets.

The full table of threats and controls, with the code that implements each, is in
[docs/threat-model.md](docs/threat-model.md).

## Known limitations

- **Not validated against live services yet.** The behaviour against the real Telegram API and a
  real Claude Code session has been tested only with fakes. Some Claude Code behaviours are marked
  "needs live verification" in the docs.
- **Account takeover.** Anyone controlling the owner's Telegram account can use every capability,
  including approving tools and `/resume`. TOTP for high-risk actions is planned, not built.
- **Redaction is best effort.** Secrets without a known shape that are not in an env file pass
  through, as do values split or re-encoded by Claude. Text typed by the owner is not redacted.
- **Screenshots are not redacted.** Anything visible is sent. Every image says so in its caption.
- **Risk rules are heuristics.** They catch common destructive commands, not all of them; they are
  an extra tap, not a sandbox.
- **No end-to-end encryption.** Telegram can read the conversation.
- **Development-channel flag.** Claude Code runs this channel only through
  `--dangerously-load-development-channels`, which bypasses its allowlist for the entry you name.
- **Pairing can be disrupted.** Anyone who knows the bot username can cancel a pairing in progress
  with five wrong codes; they cannot gain access.
- **Windows permissions.** File modes are not enforced on Windows; the state directory relies on the
  user profile's ACL. Pipe ACLs are not managed.
- **`/stop` does not cut text in flight** except through tmux on Linux and macOS; it blocks the next
  tool call. It does not undo a tool call already running. The brake hook fails open when the hook
  process itself cannot run (for example `bun` missing from `PATH`).
- **One bot, one session.** With several sessions, hook events are authenticated but not routed
  per session.
- **A capture can reach the local network.** `/shot <url>` loads any `http`/`https` URL from the PC,
  loopback and LAN included, with no cookies. This is intended for dev servers.
- **Token in the environment.** `TELEGRAM_BOT_TOKEN` overrides the file and may be visible to other
  processes of the same user.

Do not use `--dangerously-skip-permissions` with this project.
