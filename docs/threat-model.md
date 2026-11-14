# Threat model

Whoever controls the bot controls the PC, so security is part of the MVP. The design assumes the
chat with the bot is not secret: messages are encrypted in transit to Telegram, but Telegram can
read them, and bot chats have no end-to-end encryption.

This is the threat table from `docs/plan.md` ("Seguridad"), kept up to date. Status is
**Implemented** (with the code that does it) or **Planned** (with the flow that will).

## Threats and controls

| Threat | Control | Status |
| --- | --- | --- |
| A stranger writes to the bot | Allowlist by the sender's user id (`from.id`), never the chat id. Everything else is dropped silently. Private chats only in the MVP | **Implemented (F1).** Inbound chain in `src/application/pipeline/`: `PrivateChatOnlyStep`, `PairingClaimStep` (the only thing an unknown sender can trigger; only a successful claim gets a reply), `AuthenticateSenderStep` (by `sender.id`). Acceptance: `tests/acceptance/F1.test.ts` |
| Pairing code intercepted or guessed | 128-bit code from the OS CSPRNG, valid 120 s and once; only its SHA-256 is stored; constant-time comparison; 5 failed attempts cancel the pairing; access only after the owner confirms the claimant's name, @username and id at the terminal | **Implemented (F1).** `src/domain/Pairing.ts`, `src/domain/pairingCode.ts`, `src/adapters/system/CryptoRandomSource.ts`, `src/adapters/system/Sha256SecretHasher.ts`, `src/application/use-cases/ClaimPairing.ts`, `ConfirmPairing.ts`, `src/adapters/cli/pairCommand.ts` |
| The bot token leaks | Token in a 0600 file outside the repository and out of logs. With it someone can impersonate the bot, but not forge messages from your id. Revoke it in BotFather | **Implemented (F1).** `<stateDir>/.env` written by `src/adapters/storage/DotEnvTokenStore.ts` via `writeSecretFile` (0600, state dir 0700; on Windows the user-profile ACL protects it, chmod is a no-op). Never accepted as a CLI argument (`src/adapters/cli/runCli.ts`); read without echo (`ConsoleTerminal.askSecret`). Telegram errors are reduced to redacted summaries (`src/adapters/telegram/redact.ts`) and the channel and CLI loggers are wrapped in `RedactingLogger`. A malformed token is rejected before any request (`botToken.ts`) |
| Your Telegram account is hijacked | Telegram two-step verification required by the guide; optional TOTP for high-risk actions; lock after inactivity | **Planned** (guide: publication phase; TOTP and inactivity lock: after F3) |
| A secret leaves through the chat | Redaction in the outbound pipeline: tokens with known prefixes, `.env` values, private keys | **Implemented (F2).** Decorators over `ChatGateway`: `RedactingChatGateway` (domain `SecretRedactor` in `src/domain/redaction/`: Anthropic, OpenAI, GitHub, GitLab, Slack, AWS key ids, Google, Stripe, npm, Telegram bot tokens, JWTs, `Bearer` tokens, URL passwords, whole PEM private-key blocks, and exact values from the project's `.env`/`.env.*` plus the bot token) runs before `ChunkingChatGateway`, so a secret cannot straddle two messages. `src/composition/outbound.ts` is the only place the raw Telegram gateway exists and exports only `buildOutbound()`; `tests/composition/outbound.test.ts` enforces it. Only redaction counts are audited. Screenshots (F5) do not pass through it: see the next row |
| A secret leaves through a screenshot | Images cannot be redacted; every image says so in its caption, and only the owner (or Claude, through a tool call) can ask for one | **Implemented (F5), accepted risk.** The caption ("images do not go through secret redaction") is itself redacted and fitted by `RedactingImageGateway` inside `buildOutbound()`. Images go only to the private chat of an allowlisted sender (`AuthorizeReplyTarget`, the `reply` rule), never to the dev listener. Whatever is on the screen or the page (an `.env` open in an editor, a token in a terminal) reaches Telegram as pixels |
| Claude is steered into capturing and sending something | `send_screenshot` follows the `reply` rules and is a normal tool call | **Implemented (F5).** Same chat rule as `reply` (live allowlist, refusals audited); the tool is a tool call like any other, so the permission prompt (F3) and the `/stop` brake (F6) apply to it. Listed only when a capture strategy exists and a token and the allowlist are available |
| A page capture reaches the local network, or a crafted URL abuses the browser | URL policy, argument arrays, a throwaway profile | **Implemented (F5, ADR 0010).** `parseCaptureUrl`: only `http:`/`https:`, no credentials, no `file:`/`chrome:`/`javascript:`/`data:`..., no whitespace, nothing starting with `-`. **Loopback and LAN addresses are allowed on purpose**: capturing the dev server is the feature, and the caller is the authenticated owner or Claude behind a permission prompt, both of whom can already reach those addresses from this PC. The browser runs with an argument array (no shell), the URL last after `--` (Chromium stops parsing switches there), a 45 s kill timeout, and `--user-data-dir` in a fresh private directory deleted afterwards, so a capture never sees the user's cookies or sessions. The audit keeps the host only, never the path or query |
| Capture files or a browser profile are left on disk or read by others | Private, random, always removed | **Implemented (F5).** `<stateDir>/tmp/<random>/` (0700) with `<random>.png` (0600), removed on success, failure and timeout (`CaptureScratch.dispose` in a `finally`). Native tools run with argument arrays, timeouts and output paths we generate; the Windows script is a constant and gets its path through an environment variable |
| Claude is steered into messaging other chats | The `reply` tool only accepts the private chat of a currently allowlisted sender | **Implemented (F2).** `src/application/use-cases/SendReply.ts` checks the live allowlist on every call (revocation is immediate), refuses anything else with an MCP error result and audits `reply.refused`. Plain text only (no `parse_mode`) and link previews disabled, so Claude's output cannot carry markup or hidden links |
| Flooding the bot | Per-sender rate limit; throttled logs | **Implemented (F2).** `RateLimitStep` (token bucket, burst 20, 1 message / 3 s, one notice per minute, audited) after authentication; the drop log lines for strangers and non-private chats are throttled to one per sender (or chat) per minute with a suppressed count (`src/domain/EventThrottle.ts`) |
| Approving something destructive by mistake | `RiskPolicy` detects patterns such as `rm -rf`, `git push --force` or `DROP` and asks for a second tap | **Implemented (F3).** `src/domain/permissions/RiskPolicy.ts` (table of 20 rules over `input_preview`, erring towards high; an elided or unserializable preview is high). High risk needs Approve then Confirm within 30 s (`awaiting_confirmation` in `PermissionRequest`); a text `yes <id>` cannot approve it |
| Stale or double-tapped button | Each button carries the `request_id` from Claude Code; the state machine refuses to resolve twice; the keyboard is removed on resolution | **Implemented (F3).** Button data `p1:<id>:<action>` parsed strictly (`src/application/permissions/callbackData.ts`). `ResolvePermission` stores the decision with compare-and-set before sending the verdict, so a double tap or a racing expiry yields one verdict; every copy is edited and loses its buttons. Expired, resolved and other-session requests answer with a toast and change nothing |
| Misleading text in a permission preview | `description` and `input_preview` are shown as escaped plain text, without formatting or links | **Implemented (F3).** Prompts are plain text (no `parse_mode`) with link previews disabled, redacted by `RedactingPromptGateway` and fitted to one message keeping the start and the end of the input (the dangerous part of a long command is at its end). Telegram still auto-links bare URLs |
| Another local process writes to the hooks socket | Socket with mode 0600 inside the user's directory | **Implemented (F4, ADR 0008).** Unix socket `<stateDir>/hooks.sock`, chmod 0600 inside the 0700 state directory (or a short fallback directory that both sides require to be owned by the user and 0700); a named pipe on Windows. Every frame carries an HMAC-SHA256 over its JSON with a 32-byte secret from `<stateDir>/hooks.key` (0600), verified in constant time, so the secret never travels. Frames are size-capped (256 KiB), time-limited (2 s) and bounded in number; rejected ones are counted and logged by reason only. Only the poller listens; never a network socket (`src/adapters/ipc/`) |
| Claude does something harmful and must be stopped now | Panic button `/stop`: a brake flag checked by a `PreToolUse` hook before every tool call, pending permission requests denied, best-effort interrupt; `/resume` releases it | **Implemented (F6, ADR 0003).** `<stateDir>/brake.json` (0600, atomic) read by `src/brakeHook.ts` (synchronous, every tool, node builtins only), which prints `continue: false` plus a `deny`. Missing flag: not braked; present but unreadable: braked. `StopSession` denies every open request of this session once via `ResolvePermission`. While braked, chat messages are not forwarded, new requests are denied unrelayed, and approvals are refused. Escape via `tmux send-keys` only inside tmux and not on Windows (Linux, macOS since F5) (pane id validated, argument array, timeout). `telegram-bridge stop`/`resume` at the terminal. Only an allowlisted sender can trigger it |
| No record of what was approved | Append-only audit: who, when, what and which verdict | **Implemented (F1-F3).** `audit_log` table with triggers that reject `UPDATE` and `DELETE` (`src/adapters/storage/sqlite.ts`); no update or delete API (`SqliteAuditLog`). Every pairing and allowlist change is audited, without codes, tokens or message text. F2 adds `message.forwarded` (sender id, message id, length), `message.rate_limited`, `reply.sent` (chat id, parts, redaction count), `reply.refused`, `reply.failed`; never message text or secret values. F3 adds `permission.relayed` (tool, risk, rule ids), `permission.confirmation_requested`, `permission.approved` and `permission.denied` (who, tool, risk, button or text), `permission.verdict_failed`, `permission.expired`, `permission.resolved_locally`; never the description or the input. F6 adds `brake.engaged` (actor, reason length only), `session.stopped` (requests denied, interrupt result), `brake.released`, and `permission.denied` with `via: stop` or `via: brake`. F5 adds `screenshot.sent` and `screenshot.not_sent` (actor, chat id, kind, host only, bytes, photo or document, reason); never the URL's path or query, the caption or an error text |

## Additional F1 notes

- **Two pollers.** Telegram serves one `getUpdates` consumer per bot. The channel and the `pair`
  CLI coordinate through a heartbeated lock row (ADR 0006), so the CLI never competes with a
  running session.
- **Concurrent writers.** The channel and the CLI share `bridge.sqlite` (WAL, busy timeout).
  Pairing transitions are compare-and-set on a revision number, so a claim and a replacement
  racing in two processes cannot both win.
- **Confirmation is fail-safe.** The pairing is marked confirmed before the sender is added; a
  crash in between leaves access denied.

## Additional F2 notes

- **Redaction is best effort.** It recognizes known credential shapes and the literal values of
  the project's env files read at startup. Secrets without a known prefix that are not in an env
  file (a password typed in a source file, a key printed in a new format, a value split or
  re-encoded by Claude, such as base64 or with spaces) pass through. Values of fewer than 8
  characters and lowercase dictionary-like words are never redacted, to keep prose intact.
- **What is redacted is only the text sent through `reply` and bot notices.** Inbound text from
  the owner is not redacted (it goes to the local session). Logs never contain message text.
- **Busy state is unknown.** The bot cannot tell whether Claude is mid-turn, so it never says
  "queued" yet; events still queue in the session (ADR 0005). Since F4, hooks feed
  `SessionActivity` (`TrackSessionActivity`); without hooks it stays `unknown`.

## Additional F3 notes

- **Who can approve.** A verdict is sent only from `ResolvePermission`, after a button tap that
  passed the tap path (private chat, the chat is the sender's own, `from.id` allowlisted, rate
  limit, strict button data) or a text verdict that passed the whole inbound chain; the use case
  checks the allowlist again. Unauthorized taps get no answer at all. The capability is declared
  only with a bot token and the allowlist available; the dev HTTP listener cannot answer prompts.
- **Fail closed.** Anything unexpected sends no verdict: a malformed request (not relayed), a
  repeated id, a request of another session, a process that does not poll (not relayed), a
  verdict that cannot be written (state back to pending), expiry (never a verdict). The terminal
  dialog always stays open and authoritative.
- **One verdict per request.** The decision is stored with compare-and-set before the verdict is
  sent, so concurrent taps, copies on several phones and the expiry timer cannot double-send.
- **At rest.** `permission_requests` keeps description and input only while a request is open;
  closed rows keep the tool name, the outcome and who decided. Rows of another session are
  expired when this process takes the poller lock (ADR 0007).
- **Risk rules are a heuristic.** Patterns over the preview catch common destructive commands,
  not every one (an obfuscated command, a script that deletes files, an MCP tool with harmful
  effects). Low risk still needs an explicit tap; the second tap is an extra guard, not a
  sandbox.
- **Account takeover.** Anyone controlling the owner's Telegram account can approve tool use.
  Telegram two-step verification remains the main control; TOTP for high-risk approvals is still
  planned.
- **Answered at the terminal.** Without a hook signal the phone keeps the buttons until expiry; a
  tap then shows "Approved" while Claude Code drops the verdict for the closed id. F4's
  `PostToolUse` hook narrows this: a tool that ran closes the matching prompt. A local denial
  still waits for expiry.

## Additional F4 notes

- **The hook runs in the user's session.** `src/hook.ts` imports only node builtins and fails
  open: exit 0, nothing on stdout, a 1.5 s hard deadline. It never creates the secret or the state
  directory, so a session where the bridge never ran is untouched. The fail-closed brake is F6.
- **Least data over IPC.** The hook forwards only the fields the channel uses, clamped. It never
  forwards the prompt text or `tool_response`.
- **Notices go out like replies.** They go through `buildOutbound()` (redaction, then chunking),
  to allowlisted senders only, fitted to one message. Audit rows carry the event and the length,
  never the text. A notice contains up to 3,500 characters of Claude's final message.
- **Windows named pipe squatting.** Pipe names are machine-wide and their ACLs are not managed. A
  process of another local user that creates the name before the channel starts would receive hook
  payloads (but not the secret), and notices would stop working (the listener reports `in_use`).
  This is accepted for single-user PCs (ADR 0008).
- **Hook events from other sessions.** Every session with the plugin's hooks reports to the
  polling process. They are authenticated (same user, same key) but not routed. Notices name the
  project. Busy state is shared, and a `PostToolUse` from another session could close a matching
  pending prompt's buttons; it never sends a verdict.

## Additional F6 notes

- **What the brake guarantees.** No new tool call runs while the flag exists, in any session
  that resolves the same state directory, on every OS. It does not cut text being generated
  (except inside tmux, not on Windows), and it does not undo a tool call already running.
- **Fail open on a broken install, closed on a doubtful flag.** A missing flag or state
  directory, or a hook that cannot start or times out (`onFailure: "continue"`), lets calls
  through. A flag that exists but cannot be read or parsed blocks. Anyone who can delete files in
  the user's state directory can release the brake, as they could already read the token.
- **Who can engage it.** Only an allowlisted sender (the command runs after authentication) or
  the local user through the CLI. A stranger's `/stop` is dropped like any other message. Anyone
  who controls the owner's Telegram account can also `/resume`, and then approve tools; the F3
  account-takeover note applies.
- **Keystroke injection.** The tmux controller sends exactly `Escape` to the pane id inherited
  from Claude Code, validated as `%<digits>`, as an argument array with no shell and a 2 s
  timeout. It never targets another pane. Another process that changes `TMUX_PANE` in the
  channel's environment could aim the Escape at another pane of the same user; it already runs
  as that user.
- **Prompts left open by `telegram-bridge stop`.** The CLI cannot reach the channel's prompts.
  While braked they cannot be approved from the chat, and the terminal dialog stays authoritative.
- **The reason text.** The owner's optional `/stop` reason is shown at the terminal and stays in
  the conversation (`stopReason`), so Claude reads it after a resume. It is one line of at most
  200 characters, never audited and never logged.

## Additional F5 notes

- **What a screenshot shows.** Anything visible on the PC at that moment, including other
  windows, notifications and other users' content shown on the screen. Redaction does not apply.
  Use `/shot <url>` for a single page when the desktop may show something private.
- **Pages see what the PC sees.** A capture request can make the PC load any http(s) URL,
  including routers and admin panels on the LAN, with no cookies (throwaway profile). The
  response is only shown to the owner. Anyone who controls the owner's Telegram account can do
  this too; the F3 account-takeover note applies.
- **Busy and size limits.** One capture at a time per channel process; images over 50 MB are
  not sent (the chat says so), so a capture cannot be used to exhaust disk or upload.
- **Wayland dialogs.** Some compositors ask the person at the PC before a capture; the request
  times out after 20 s if nobody answers.

## Known limits and open risks

- **Pairing denial of service.** Anyone who knows the bot's username can send five wrong
  `/start` codes during the 120 s window and cancel the pairing. They cannot gain access; the
  owner runs `pair` again.
- **Log volume.** Since F2 the drop line is written at most once per sender per minute. A flood
  from many distinct accounts still writes one line per account per minute; the throttle forgets
  keys beyond 1024, which can only undercount the suppressed numbers.
- **Windows permissions.** File modes are not enforced on Windows; the state directory must be
  under the user's profile, whose ACL is the protection. The code does not touch ACLs.
- **Token in the environment.** `TELEGRAM_BOT_TOKEN` overrides the file. Environment variables
  are visible to other processes of the same user on some systems; the file is the recommended
  storage.
