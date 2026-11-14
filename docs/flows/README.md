# Flows

One brief per flow: objective, steps, acceptance, sequence diagram and manual verification. The
design behind them is `docs/plan.md`; the architecture as built is `docs/architecture.md`.

## Index

Every flow is implemented and merged. "Automated" means tests with fakes (fake Telegram Bot API,
an MCP client standing in for Claude Code, fake clock). None has been run against live Telegram
or a live Claude Code session yet; the checklist below is how that happens.

| Flow | Title | Status |
| --- | --- | --- |
| [F0](F0.md) | Skeleton and technical proof | Implemented. Automated: real `main.ts` over stdio with an MCP client. Live: the `curl` round trip in a real session is pending. Findings: [ADR 0005](../adr/0005-f0-findings.md) |
| [F1](F1.md) | Installation and pairing | Implemented. Automated acceptance (`tests/acceptance/F1.test.ts`). Live: `init`, `pair`, stranger test pending |
| [F2](F2.md) | Two-way messaging | Implemented. Automated acceptance. Live: phone to session and back pending |
| [F3](F3.md) | Permission relay with buttons | Implemented. Automated acceptance. Live: terminal dialog closing and the exact preview text pending |
| [F4](F4.md) | Notices via hooks | Implemented. Automated acceptance, including the real `hook.ts` as a child process. Live: hook firing, `UserPromptSubmit` for chat turns, Windows async hooks pending |
| [F5](F5.md) | Screenshots on demand | Implemented. Automated acceptance with fake capture programs. Two smoke tests passed on one Windows machine (page and screen). Live: Telegram delivery, Wayland and X11 pending |
| [F6](F6.md) | Panic button `/stop` | Implemented. Automated acceptance, including the real `brakeHook.ts`. Live: effect of `continue: false` on a turn in flight, tmux Escape pending |
| [F7](F7.md) | Options (`ask_choice`) and `/skills` | Implemented. Automated acceptance (`tests/acceptance/F7.test.ts`). Live: whether a slash command in a channel event runs, and how Claude acts on "Use the skill /name", pending |
| [F8](F8.md) | Git from the chat (`/diff`, Commit / Revert / Open PR) | Implemented. Automated acceptance (`tests/acceptance/F8.test.ts`) with the real git on temp repositories, including a hostile configuration. Live: the document on the phone and how Claude carries out each instruction pending |
| [F9](F9.md) | Pinned status message | Implemented. Automated acceptance (`tests/acceptance/F9.test.ts`) with hook events and a fake clock. Live: silent pin and edits, 429 rate for edits pending |
| [F10](F10.md) | Incoming images and files | Implemented. Automated acceptance (`tests/acceptance/F10.test.ts`) with a fake `getFile` and download. Live: real photo sizes, albums, `getFile` on real files pending |

The other later flows (F11 to F15) are in [../roadmap.md](../roadmap.md).

Where a flow doc and the code differ, the code wins. Known cases are listed in the architecture
and roadmap notes; for instance F2's command list (`/start`, `/help`, `/status`) has since grown
with `/stop`, `/resume`, `/shot`, `/skills`, `/diff`, `/pin` and `/unpin`, and F2's "only text" notice now reads "only text,
photos and files" once F10 is wired.

## Live-validation checklist

Run this once, in order, when you have a bot token. Each part builds on the previous one. Tags:
**[All]** any OS, **[Windows]** Windows only, **[Linux]** Linux only, **[Linux/tmux]** Linux (or
macOS) inside tmux. Each item points to the flow doc that explains it in detail. When something
behaves differently from the doc, write it down: those are the "needs live verification" items
that go into the ADRs.

Conventions: `<stateDir>` is the throwaway directory below; "the session" is Claude Code started
with the channel; the audit query is the one at the end of F1's manual verification.

### Part 0: Prerequisites

- [ ] **[All]** Bun installed (`bun --version`), Claude Code signed in with claude.ai or a Console
  key, and `claude --version` noted (2.1.295 or later recommended). Team or Enterprise: channels
  enabled by an admin.
- [ ] **[All]** Two-step verification enabled on your Telegram account.
- [ ] **[All]** A bot created with BotFather and its token at hand (do not paste it anywhere except
  the `init` prompt).
- [ ] **[All]** A second Telegram account (or a friend's) for the stranger tests.
- [ ] **[All]** In the checkout: `bun install` and `bun run check` pass.
- [ ] **[All]** Use a throwaway state directory so nothing touches the real one
  ([F1](F1.md), manual verification). PowerShell:
  `$env:TELEGRAM_BRIDGE_HOME = "$env:TEMP\tb-live"`; bash: `export TELEGRAM_BRIDGE_HOME=/tmp/tb-live`.
  Set `TELEGRAM_BRIDGE_LOCALE=en` if you prefer English output. Use the same variables in every
  terminal below.

### Part 1: The channel contract without Telegram (F0)

Source: [F0](F0.md), manual verification. This proves Claude Code accepts the server as a channel.

- [ ] **[All]** Start `claude --dangerously-load-development-channels server:telegram-bridge` in the
  checkout with `TELEGRAM_BRIDGE_DEV_PORT=8788`. Expect the development-channels warning, the "New
  MCP server found" prompt, the `Channels (experimental)` notice and `/mcp` showing the server
  connected.
- [ ] **[All]** Find the dev listener's token: it is printed once to the server's stderr with
  ready-to-paste `curl` lines (start Claude Code with `--debug` and look in
  `~/.claude/debug/<session-id>.txt`; confirm and note where it actually appears). Then
  `curl -N -H "Authorization: Bearer <token>" http://127.0.0.1:8788/events` in a second terminal and
  `curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:8788/ --data "What is in this directory? Reply through the channel."`
  in a third (use `curl.exe` in Windows PowerShell). Claude receives it, calls `reply`, and the reply
  shows up in the first curl.
- [ ] **[All]** The same POST without the token answers `401`; with `-H "Origin: https://example.com"`
  or `-H "Host: example.com"` it answers `403`. Nothing reaches Claude.
- [ ] **[All]** With a bot token configured, `TELEGRAM_BRIDGE_DEV_PORT` is ignored: no listener, and
  stderr says why. A malformed value (`87 88`) is logged and the server keeps running.
- [ ] **[Windows]** Count the `bun.exe` processes running `src/main.ts` with
  `Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Select-Object ProcessId, CommandLine`,
  then open a second session and count again: one process per session (ADR 0005 (a)). Exit
  Claude Code and confirm the processes are gone. On Linux or macOS use your process list for the
  same check.
- [ ] **[All]** Start `claude` without the channel flag: the server still starts, but a POST must not
  reach Claude.
- [ ] **[All]** Unset `TELEGRAM_BRIDGE_DEV_PORT` (the dev listener is for setups without a bot and
  does not start once one is configured).

### Part 2: Install and pair (F1)

Source: [F1](F1.md), manual verification.

- [ ] **[All]** `bun run bridge -- init`, paste the token (nothing echoes). Expect the success line
  with the bot's name. `.env` and `bot.json` exist in `<stateDir>`.
- [ ] **[Linux]** `ls -l <stateDir>` shows `-rw-------` for `.env` and `bridge.sqlite`, `drwx------`
  for the directory.
- [ ] **[All]** A wrong token prints a rejection and saves nothing. Optionally
  `init --token-stdin` from a file.
- [ ] **[All]** `bun run bridge -- pair` with no session running: QR, link, 120-second countdown. Scan,
  press Start; the phone says the code was received; the terminal shows your name, @username and id;
  confirm. `bun run bridge -- access list` shows the account.
- [ ] **[All]** Pair again with the session running (start it as in Part 1 but without the dev port; stderr
  or `claude --debug` shows `telegram polling started`). `pair` says the session is receiving the
  messages and the claim arrives through the channel. Decline once with `n`: nobody is added.
  Then pair for real.
- [ ] **[All]** From the second account send plain text, `/start` and `/start wrongcode`: no reply at
  all and nothing in the session. stderr shows `dropped message from an unauthorized sender` with that
  id and no text. (This is F1's acceptance check.)
- [ ] **[All]** Let a pairing expire (2 minutes), then send five wrong codes: cancelled.
- [ ] **[All]** `access revoke <id>` then check the account is ignored; pair again afterwards.
- [ ] **[All]** The token appears nowhere in stderr or terminal output; the audit query shows no codes
  or tokens.
- [ ] **[All]** With an empty state directory the server stays connected in `/mcp` and logs that
  Telegram is not configured once.

### Part 3: Two-way messaging (F2)

Source: [F2](F2.md), manual verification.

- [ ] **[All]** Allow the reply tool in your Claude Code settings:
  `{"permissions": {"allow": ["mcp__telegram-bridge__reply"]}}`
  ([F3](F3.md#the-reply-tool-needs-its-own-permission)). If you run as a plugin, check the exact tool
  name with `/permissions` and record it.
- [ ] **[All]** Start the session. stderr shows `loaded project env values for redaction` and
  `telegram polling started`.
- [ ] **[All]** "List the files in this directory and reply to me": the phone shows "typing..."; the
  session shows the `<channel ...>` event with `chat_id`, `message_id`, `user`, `ts`.
- [ ] **[All]** The answer arrives as plain text (no Markdown or HTML rendering, no link preview). A long answer
  arrives as several ordered messages. A "reply to my message" answer is threaded.
- [ ] **[All]** `/start`, `/help`, `/status` answer at once and do not reach Claude; `/somethingelse`
  reaches Claude as text.
- [ ] **[All]** A sticker produces one "only text, photos and files" notice (photos are F10, Part 9).
- [ ] **[All]** Redaction: put `DEMO_SECRET=Zq8vR2pL0042` in the project's `.env`, restart the session, ask
  Claude to reply with its value: the chat shows `[REDACTED]`. Also a fake `ghp_` token.
- [ ] **[All]** Ask Claude to send to `chat_id 12345`: refused, `reply.refused` in the audit.
- [ ] **[All]** Revoke yourself, let Claude reply: refused. Pair again.
- [ ] **[All]** Paste 25 messages quickly: one "slow down" after 20.
- [ ] **[All]** The second account gets no reply to text, `/help` or `/status`.
- [ ] **[All]** Audit query: `message.forwarded`, `reply.sent`, `reply.refused`, `message.rate_limited`,
  no text.

### Part 4: Permission relay (F3)

Source: [F3](F3.md), manual verification. Put the session in manual permission mode (`Shift+Tab`).

- [ ] **[All]** Approve: "create hello.txt containing hi". Prompt on the phone with tool, risk low, preview
  and id. Tap Approve: the terminal dialog closes by itself, the file exists, the message shows who
  approved and has no buttons. (Live check: the dialog really closes.)
- [ ] **[All]** Deny a second request: the terminal shows the tool was rejected.
- [ ] **[All]** High risk: ask for `rm -r some-scratch-dir`. Prompt says HIGH; Approve turns into Confirm and
  Cancel; after 35 s it reverts; Approve then Confirm runs it. Note the exact `input_preview` text
  Claude Code sends.
- [ ] **[All]** Double tap Approve: one run, the second tap says already resolved.
- [ ] **[All]** Answer at the terminal first: the phone keeps its buttons (F4 fixes this for approvals in
  Part 5); untouched it shows expired after 10 minutes.
- [ ] **[All]** Text verdicts: `yes <id>` and `Sí <id>` approve a low-risk prompt without reaching Claude; on
  a high-risk prompt `yes <id>` says to use the buttons.
- [ ] **[All]** A second account never receives prompts; `yes <id>` from a group is ignored.
- [ ] **[All]** Revoke while a prompt is open: the tap gets no answer and the terminal keeps waiting.
- [ ] **[All]** Leave a prompt open, quit and restart Claude Code: the old prompt shows expired.
- [ ] **[All]** `/status` shows pending requests; the audit has `permission.*` rows with no commands or file
  contents.

### Part 5: Hooks and plugin packaging (F4)

Source: [F4](F4.md), manual verification; [ADR 0009](../adr/0009-plugin-layout.md) items. From here
on the hooks must be loaded. Pick one (or do both on different days):

- [ ] **[All]** Plugin route: `claude --plugin-dir <checkout>`, with the channel flag in the
  `plugin:telegram-bridge@<marketplace>` form. Record which `<marketplace>` value works, whether the
  plugin's server replaces the `.mcp.json` entry, the first-start `bun install` time, and the
  reply tool name. Check that `/telegram-bridge:init`, `/telegram-bridge:pair` and
  `/telegram-bridge:access` appear (the skills, see `skills/`).
- [ ] **[All]** Settings route: the snippet in [F4](F4.md#for-people-not-using-the-plugin) with the absolute
  path of the checkout, plus the `server:telegram-bridge` flag.
- [ ] **[All]** stderr shows `listening for hook events`. **[Linux]** `ls -l <stateDir>/hooks.sock` shows
  `srw-------`. **[Windows]** `[System.IO.Directory]::GetFiles('\\.\pipe\') | Select-String telegram-bridge`
  lists the pipe.
- [ ] **[All]** Finished: at the terminal "list the files here and summarize them"; the phone gets one
  "finished" notice with the summary. Record whether async hooks fire on your OS and whether
  `last_assistant_message` is present.
- [ ] **[All]** From the phone ask something and let Claude `reply`: no extra "finished" notice.
- [ ] **[All]** Queued: start a long task at the terminal and write from the phone: "queued". Then a long
  task started from the phone and a second message: also "queued" (does `UserPromptSubmit` fire for chat
  turns?).
- [ ] **[All]** Needs your answer: let Claude wait for input about 60 s with no previous notice: a "needs your
  answer" notice. Record the exact `Notification` message texts.
- [ ] **[All]** Permission prompt: the phone gets the F3 buttons and no extra notice after about 6 s. Approve at
  the terminal: the phone's prompt becomes "Answered at the terminal" with no buttons.
- [ ] **[All]** Fail open: quit the channel or start Claude without it: hooks exit at once and nothing breaks;
  `TELEGRAM_BRIDGE_DEBUG=1` shows `unreachable`.
- [ ] **[All]** Redaction in notices: finish with "the value is Zq8vR2pL0042": the notice shows `[REDACTED]`.
- [ ] **[All]** Audit query: `notice.sent` rows with event and length only.

### Part 6: Screenshots (F5)

Source: [F5](F5.md), manual verification. Have a dev server running (for example `bunx serve -l 3000`).

- [ ] **[All]** `/status` shows `Screenshots: screen, web pages` (or what is available); `/help` lists `/shot`.
- [ ] **[Linux]** Install the tool for your display server (Wayland: `grim`, `spectacle` or
  `gnome-screenshot`; X11: `maim`, `scrot` or `imagemagick`) and `chromium` or another browser. Start
  Claude from a terminal inside the desktop. The log shows `screenshot capture` with the kinds.
  Record which tool worked (`captured the screen`) and whether the compositor shows a permission dialog.
- [ ] **[Windows]** Chrome or Edge is found automatically; with several monitors the photo shows all of
  them. Set `TELEGRAM_BRIDGE_BROWSER=C:\nope.exe` and restart: `/shot localhost:3000` says the variable is
  not an existing program. Optionally rerun the smoke tests: `$env:TELEGRAM_BRIDGE_SMOKE='1'; bun test tests/smoke`.
- [ ] **[All]** `/shot`: a photo with the "images do not go through redaction" caption.
- [ ] **[All]** `/shot localhost:3000`: a photo of the page, caption with `http://localhost:3000/`.
- [ ] **[All]** `/shot file:///etc/passwd` and `/shot javascript:alert(1)`: the "only http or https" message.
- [ ] **[All]** `/shot` twice quickly: one photo and one "already running".
- [ ] **[All]** Ask Claude to send a screenshot with `send_screenshot`: a permission prompt appears (the tool
  is not pre-allowed); approve; the photo arrives.
- [ ] **[All]** `<stateDir>/tmp` is empty after each capture; audit shows `screenshot.sent` with host only.
- [ ] **[Linux]** Hide the screen tools or start `claude` from a TTY: `/shot` explains what to install, and
  `/shot localhost:3000` still works.

### Part 7: Panic button (F6)

Source: [F6](F6.md), manual verification. Hooks from Part 5 must be loaded.

- [ ] **[Linux/tmux]** Start `tmux`, then `claude` with the channel in a pane (`echo $TMUX_PANE` shows
  `%N`). Ask for a long task, send `/stop testing`: the reply says Escape was sent, the terminal stops
  the current response, `brake.json` is `-rw-------`.
- [ ] **[Windows]** Start `claude` in Windows Terminal, ask for a long task, `/stop`: the reply says interrupting is
  not available and that Claude stops at its next tool call. The current text may finish; then the next
  tool call is refused. Record the effect of `continue: false` on a turn in flight.
- [ ] **[All]** At the terminal type "continue": the first tool call is refused and Claude stops, showing the
  `stopReason`. Record how it renders.
- [ ] **[All]** "hello" from the phone: the bot says the brake is engaged and nothing reaches Claude;
  `/status` shows the brake.
- [ ] **[All]** In manual permission mode: `/resume`, request a command needing approval, then `/stop`: the prompt
  becomes "Denied by /stop" without buttons and the terminal dialog closes as denied.
- [ ] **[All]** `/resume`: "continue" works again.
- [ ] **[All]** At the terminal `bun run bridge -- stop`, try a tool (refused), `bun run bridge -- resume`.
  Audit shows `brake.engaged` and `brake.released` with actor `terminal`.
- [ ] **[Windows]** Corrupt flag: write garbage into `brake.json`; the next tool call is still refused and the
  message names the file; `resume` deletes it.
- [ ] **[All]** With `claude --debug`, the `PreToolUse` hook takes a few tens of milliseconds per call.
- [ ] **[Linux/tmux]** Record what one Escape does at an idle prompt with text typed in it.

### Part 8: Options and skills (F7)

Source: [F7](F7.md), manual verification.

- [ ] **[All]** Ask Claude to use `ask_choice` with two options and `allow_other`. Record the exact
  tool name in the permission prompt. The phone shows the question and three buttons; the
  session already has `choice_id`.
- [ ] **[All]** Tap an option: the session gets `kind="choice"` and the label; the message loses its
  buttons. A second tap says "already answered".
- [ ] **[All]** Tap "Other…" and type an answer: same `choice_id`. `/status` typed in between is not
  taken as the answer.
- [ ] **[All]** While braked, a tap gets the brake toast and nothing reaches Claude.
- [ ] **[All]** With a permission prompt open, tap a choice whose label contains `yes <id>`: no verdict.
- [ ] **[All]** Leave a choice for 30 minutes: "Expired". Restart the session with one open: "Cancelled".
- [ ] **[All]** `/skills` lists project and personal skills (not plugin ones). Tap one: the session
  gets "Use the skill /<name>". **Record whether Claude invokes the skill, whether a bare `/name`
  in a channel event would have run as a command, and what happens with a skill that sets
  `disable-model-invocation: true`.**
- [ ] **[All]** Start without `CLAUDE_PROJECT_DIR` from a directory that is not a project: `/skills`
  says the project is unknown.

### Part 9: Incoming files (F10)

Source: [F10](F10.md), manual verification.

- [ ] **[All]** Send a photo with a caption: the session gets the caption and the path; Claude can read
  the image. Record the photo sizes Telegram offers and which one was downloaded (`bytes` in
  the log).
- [ ] **[Linux]** `ls -l <stateDir>/inbox/<session>` shows `-rw-------` files in a `drwx------`
  directory.
- [ ] **[All]** A PDF and a `.md` as documents arrive; an `.exe`, a `.zip` and an `.svg` are refused;
  a text file renamed to `.png` is refused as a mismatch.
- [ ] **[All]** An album of several photos: one event each. Record whether Telegram delivers the album
  as separate messages in one `getUpdates` batch.
- [ ] **[All]** `TELEGRAM_BRIDGE_MAX_UPLOAD_MB=1` and a 2 MB file: refused with the limit. Also try a
  file over 20 MB: refused before any download.
- [ ] **[All]** Braked: a photo is not downloaded. A voice note gets the "only text, photos and files" notice.
- [ ] **[All]** `/status` shows the inbox. A new session removes the old session's inbox.
- [ ] **[All]** The bot token appears nowhere in stderr (`claude --debug`) or the audit.

### Part 10: Git from the chat (F8)

Source: [F8](F8.md), manual verification. In a git repository with one staged, one unstaged and
one new file.

- [ ] **[All]** `/diff`: a `changes.diff` document captioned with the summary (branch, counts,
  +/−), then three buttons. Record how the phone shows the file.
- [ ] **[All]** A fake `ghp_…` token in a changed file shows as `[REDACTED]` in the document.
- [ ] **[All]** `/diff src` narrows the diff. `/diff ../x`, `/diff -p` and `/diff :/` are refused.
  With no changes: "No changes".
- [ ] **[All]** Commit: the toast, the buttons replaced, the session gets the instruction, and Claude
  asks before `git commit`. **Record what Claude runs.**
- [ ] **[All]** Revert asks for Confirm; Cancel sends nothing; Confirm sends the revert instruction.
- [ ] **[All]** Braked: `/diff` still works, and a button gets the brake toast. `/status` shows the
  git line.
- [ ] **[Linux]** In a throwaway repository, `git config diff.external 'touch /tmp/pwned'`, then
  `/diff`: `/tmp/pwned` does not appear.

### Part 11: Pinned status (F9)

Source: [F9](F9.md), manual verification. Needs the hooks (Part 5).

- [ ] **[All]** `/pin`: a pinned message. **Record whether the phone buzzed** for the message, the
  pin or any later edit (expected: never).
- [ ] **[All]** While Claude works: "working since", "Last tool: Bash · <description>" (never the
  command), at most one change every 5 s. A permission prompt shows "waiting for your answer".
- [ ] **[All]** The turn ends: "idle since", "Last finished". No further edits while nothing changes.
- [ ] **[All]** `/stop` shows "braked"; `/resume` clears it.
- [ ] **[All]** Delete the pinned message: one new one is sent and pinned; delete that too: no third.
- [ ] **[All]** Exit Claude Code: "session ended". Start again: the same message is edited.
  `/unpin` stops updates.

### Part 12: Wrap-up

- [ ] **[All]** Record every "needs live verification" outcome in the ADRs: 0005 (findings), 0003
  (`onFailure` on a Claude Code older than 2.1.295 ignoring the unknown key), 0009 (plugin items), 0011 (skills from the chat, albums), 0012 (git instructions), 0013 (silent status), and
  the open points of each flow doc.
- [ ] **[All]** Remove the throwaway directory, unset the variables, and repeat `init` and `pair` for real.
- [ ] **[All]** Update the README: the exact install commands for the plugin route, the minimum Claude Code
  version and the "Status" section. Then add the demo.
