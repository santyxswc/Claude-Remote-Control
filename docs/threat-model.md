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
| A secret leaves through the chat | Redaction in the outbound pipeline: tokens with known prefixes, `.env` values, private keys | **Implemented (F2).** Decorators over `ChatGateway`: `RedactingChatGateway` (domain `SecretRedactor` in `src/domain/redaction/`: Anthropic, OpenAI, GitHub, GitLab, Slack, AWS key ids, Google, Stripe, npm, Telegram bot tokens, JWTs, `Bearer` tokens, URL passwords, whole PEM private-key blocks, and exact values from the project's `.env`/`.env.*` plus the bot token) runs before `ChunkingChatGateway`, so a secret cannot straddle two messages. Since the audit hardening (M3) nothing is cut before redaction anywhere: notices and prompts reach the decorators whole and are fitted after redaction, and the hook (which has no secrets) cuts long texts only at their end and flags it, so the channel drops the partial last line before redacting. `src/composition/outbound.ts` is the only place the raw Telegram gateway exists and exports only `buildOutbound()`; `tests/composition/outbound.test.ts` enforces it. Only redaction counts are audited. Screenshots (F5) do not pass through it: see the next row |
| A secret leaves through a screenshot | Images cannot be redacted; every image says so in its caption, and only the owner (or Claude, through a tool call) can ask for one | **Implemented (F5), accepted risk.** The caption ("images do not go through secret redaction") is itself redacted and fitted by `RedactingImageGateway` inside `buildOutbound()`. Images go only to the private chat of an allowlisted sender (`AuthorizeReplyTarget`, the `reply` rule), never to the dev listener. Whatever is on the screen or the page (an `.env` open in an editor, a token in a terminal) reaches Telegram as pixels |
| Claude is steered into capturing and sending something | `send_screenshot` follows the `reply` rules and is a normal tool call | **Implemented (F5).** Same chat rule as `reply` (live allowlist, refusals audited); the tool is a tool call like any other, so the permission prompt (F3) and the `/stop` brake (F6) apply to it. Listed only when a capture strategy exists and a token and the allowlist are available |
| A page capture reaches the local network, or a crafted URL abuses the browser | URL policy, argument arrays, a throwaway profile | **Implemented (F5, ADR 0010).** `parseCaptureUrl`: only `http:`/`https:`, no credentials, no `file:`/`chrome:`/`javascript:`/`data:`..., no whitespace, nothing starting with `-`. **Loopback and LAN addresses are allowed on purpose**: capturing the dev server is the feature, and the caller is the authenticated owner or Claude behind a permission prompt, both of whom can already reach those addresses from this PC. The browser runs with an argument array (no shell), the URL last after `--` (Chromium stops parsing switches there), a 45 s kill timeout, and `--user-data-dir` in a fresh private directory deleted afterwards, so a capture never sees the user's cookies or sessions. The audit keeps the host only, never the path or query |
| Capture files or a browser profile are left on disk or read by others | Private, random, always removed | **Implemented (F5).** `<stateDir>/tmp/<random>/` (0700) with `<random>.png` (0600), removed on success, failure and timeout (`CaptureScratch.dispose` in a `finally`). Native tools run with argument arrays, timeouts and output paths we generate; the Windows script is a constant and gets its path through an environment variable |
| A choice button is taken for an approval, or an approval for a choice | Choices only ever produce text for the session; separate, strictly parsed button prefixes | **Implemented (F7, ADR 0011).** Button data `c1:<id>:<n>` (choices), `k1:` (skills) and `p1:` (permissions) are parsed by anchored regexes in `ButtonTapHandler`; only `p1:` reaches `ResolvePermission`. A chosen label is delivered by `AnswerChoice` through `HandleInboundMessage`, not the text chain, so a label like "yes abcde" never meets `PermissionVerdictStep`. Taps are authenticated like permission taps (private chat, own chat, allowlisted `from.id`, rate limit) and refused while braked. One delivery per choice (compare-and-set), 30-minute expiry, scoped to the polling session. `ask_choice` is a normal tool call (permission prompt, brake) with the `reply` chat rule; the question and labels are sanitized and redacted (`RedactingPromptGateway` redacts button labels too) and never audited |
| A skill button runs something the owner did not mean | A tap sends one fixed instruction through the full chain | **Implemented (F7).** `/skills` lists only skills whose name matches `^[a-z0-9][a-z0-9:_-]{0,63}# Threat model

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
| A secret leaves through the chat | Redaction in the outbound pipeline: tokens with known prefixes, `.env` values, private keys | **Implemented (F2).** Decorators over `ChatGateway`: `RedactingChatGateway` (domain `SecretRedactor` in `src/domain/redaction/`: Anthropic, OpenAI, GitHub, GitLab, Slack, AWS key ids, Google, Stripe, npm, Telegram bot tokens, JWTs, `Bearer` tokens, URL passwords, whole PEM private-key blocks, and exact values from the project's `.env`/`.env.*` plus the bot token) runs before `ChunkingChatGateway`, so a secret cannot straddle two messages. Since the audit hardening (M3) nothing is cut before redaction anywhere: notices and prompts reach the decorators whole and are fitted after redaction, and the hook (which has no secrets) cuts long texts only at their end and flags it, so the channel drops the partial last line before redacting. `src/composition/outbound.ts` is the only place the raw Telegram gateway exists and exports only `buildOutbound()`; `tests/composition/outbound.test.ts` enforces it. Only redaction counts are audited. Screenshots (F5) do not pass through it: see the next row |
| A secret leaves through a screenshot | Images cannot be redacted; every image says so in its caption, and only the owner (or Claude, through a tool call) can ask for one | **Implemented (F5), accepted risk.** The caption ("images do not go through secret redaction") is itself redacted and fitted by `RedactingImageGateway` inside `buildOutbound()`. Images go only to the private chat of an allowlisted sender (`AuthorizeReplyTarget`, the `reply` rule), never to the dev listener. Whatever is on the screen or the page (an `.env` open in an editor, a token in a terminal) reaches Telegram as pixels |
| Claude is steered into capturing and sending something | `send_screenshot` follows the `reply` rules and is a normal tool call | **Implemented (F5).** Same chat rule as `reply` (live allowlist, refusals audited); the tool is a tool call like any other, so the permission prompt (F3) and the `/stop` brake (F6) apply to it. Listed only when a capture strategy exists and a token and the allowlist are available |
| A page capture reaches the local network, or a crafted URL abuses the browser | URL policy, argument arrays, a throwaway profile | **Implemented (F5, ADR 0010).** `parseCaptureUrl`: only `http:`/`https:`, no credentials, no `file:`/`chrome:`/`javascript:`/`data:`..., no whitespace, nothing starting with `-`. **Loopback and LAN addresses are allowed on purpose**: capturing the dev server is the feature, and the caller is the authenticated owner or Claude behind a permission prompt, both of whom can already reach those addresses from this PC. The browser runs with an argument array (no shell), the URL last after `--` (Chromium stops parsing switches there), a 45 s kill timeout, and `--user-data-dir` in a fresh private directory deleted afterwards, so a capture never sees the user's cookies or sessions. The audit keeps the host only, never the path or query |
| Capture files or a browser profile are left on disk or read by others | Private, random, always removed | **Implemented (F5).** `<stateDir>/tmp/<random>/` (0700) with `<random>.png` (0600), removed on success, failure and timeout (`CaptureScratch.dispose` in a `finally`). Native tools run with argument arrays, timeouts and output paths we generate; the Windows script is a constant and gets its path through an environment variable |
 (no spaces, no second command) read from the user and project skill directories (size-capped, symlinks out of the root ignored, `user-invocable: false` hidden). A tap re-reads the skills, and sends `Use the skill /<name>` as owner text through the rate limit, the brake gate and the audit. The skill itself runs under Claude Code's normal permissions |
| An incoming file carries a prompt injection or a malicious payload | Files are untrusted content; only allowlisted, verified types are kept, under our own name | **Implemented (F10, ADR 0011).** Extension allowlist AND content check (magic bytes for images and PDF; UTF-8 without NUL for text, which must not look binary); mismatches refused; no executables, archives, Office files or SVG. Stored as `<stateDir>/inbox/<session>/<32 hex>.<ext>` (0600 in 0700 directories), written as `.part` and renamed only after every check; the sender's name never builds a path. The event says `kind="attachment"` and the MCP instructions tell Claude to treat the content as untrusted. What the file *says* is not checked: text or an image can still try to steer Claude, exactly like a message typed by the owner could |
| Incoming files exhaust disk, bandwidth or the chat | Size cap, budgets, retention | **Implemented (F10).** 20 MB per file (the Bot API limit, lowerable with `TELEGRAM_BRIDGE_MAX_UPLOAD_MB`), checked on the declared size and again on the bytes received; at most 2 downloads at a time, a per-sender budget (10, then 1 per 30 s) on top of the message rate limit; 24 h TTL and a 200 MB quota swept at start, after each file and hourly; other sessions' inboxes deleted when the lock is taken; downloads run in the background and are aborted on shutdown with their partial files removed |
| The bot token leaks through a file download | The download URL never leaves its adapter | **Implemented (F10).** `https://api.telegram.org/file/bot<token>/...` is built only inside `TelegramAttachmentSource`; it is never logged, audited, forwarded or put in an error (every failure becomes a redacted `TelegramCallError`). `tests/acceptance/F10.test.ts` runs without the redacting logger and checks logs, audit rows, events and chat messages for the token |
| A diff carries secrets off the PC | The diff is redacted whole before it is cut, and the caption says redaction is best effort | **Implemented (F8, ADR 0012), accepted risk.** `/diff` sends staged and unstaged patches as a `.diff` document. `RedactingDocumentGateway` (inside `buildOutbound()`, Telegram only) redacts the entire text with the same detectors as chat text, then cuts it to 5 MB between lines; a patch the adapter read only partly (5 MB cap) drops its partial last line first, so no secret is split. Tests put a token inside a file larger than the cap and a PEM block across the cut. **Best effort**: a secret without a recognizable shape (a password in a YAML file, a private hostname) leaves the PC. Untracked files are listed by name only. Only counts and sizes are audited |
| The repository's git configuration runs a program when `/diff` reads it | A fixed set of read-only invocations, each hardened against every configuration key that starts a program | **Implemented (F8, ADR 0012).** `GitCli` can run only `rev-parse`, `config --get-regexp ^filter\.`, `status` and four `diff`s (`src/adapters/git/gitInvocations.ts`; an argv allowlist test enumerates every argv). Closed: external diff drivers and textconv (`--no-ext-diff --no-textconv`), clean/smudge/process filters (each configured driver emptied with `-c` and made non-required; an unexpressible name refuses the read), `core.fsmonitor` (`-c core.fsmonitor=false`), hooks (`-c core.hooksPath=<null device>`, and `--no-optional-locks` so `status` writes no index), the pager (`--no-pager`), submodules (`--ignore-submodules=dirty`), lazy fetches in a partial clone (`-c protocol.allow=never`, `GIT_NO_LAZY_FETCH=1`), prompts (`GIT_TERMINAL_PROMPT=0`), and environment overrides (`GIT_DIR`, `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_PARAMETERS`... are scrubbed). Argument arrays, no shell, explicit cwd, 15 s timeout, read caps, no network. `tests/adapters/git/GitCli.test.ts` shows each vector firing under a plain git and none under the adapter (git 2.55.0, Windows; CI on ubuntu and windows) |
| A hostile `/diff <path>` reaches git as an option, a glob or a path outside the project | A pure path policy before any process, then a literal pathspec after `--` | **Implemented (F8).** `parseDiffPathFilter` refuses absolute and drive paths, `..` segments, a leading `-` or `:` (also after normalization), controls, bidi and separators, and over 1024 characters; the acceptance test checks that no process is spawned. The path is passed after `--` with `--literal-pathspecs`/`GIT_LITERAL_PATHSPECS=1` |
| A `/diff` button is taken for an approval, or makes changes on its own | Buttons are instructions sent through the full chain, never verdicts | **Implemented (F8, ADR 0012).** `g1:` data is parsed by an anchored regex in `ButtonTapHandler` after its checks (private chat, own chat, allowlisted `from.id`, rate limit) and never reaches `ResolvePermission`. A tap feeds one fixed catalog instruction (nothing from the repository) into the inbound chain as owner text: rate limit, brake gate and audit apply, and every git command Claude then runs goes through the permission prompt (F3) and the brake (F6). Revert needs a second Confirm tap; buttons expire after 30 min (2 min for Confirm); a braked tap gets a toast and sends nothing |
| The pinned status exposes what the PC is doing | Off by default; hook-fed metadata only, sanitized and redacted | **Implemented (F9, ADR 0013), accepted risk.** `/pin` opts in per chat; `/unpin` stops it. The message shows the project name, the state, the last tool's name with a shell command's `description` (up to 60 characters) or a file's base name, the pending counts and times: activity metadata in a chat that is not end-to-end encrypted and that Telegram can read. Never a command, a pattern, a URL, file content or text Claude wrote. The hook now forwards only allowlisted `tool_input` fields (no `content`/`old_string`/`new_string`). Redacted and fitted in `buildOutbound()`; silent sends and pins; at most one edit per 5 s per chat and a global budget; a 429 backs off on its own timer and holds up nothing else (M1) |
| A chart spec makes the renderer fetch a URL or read a local file | Inline data only, refused at two layers | **Implemented (F11, ADR 0014).** `checkChartSpec` refuses any `url` or `href` key at any depth, image marks, `sequence`/`graticule` generators and full Vega specs. The worker's Vega loader rejects every `load`, `sanitize`, `http` and `file` call, and any attempt fails the render. resvg runs in WebAssembly with only the bundled fonts. Tests run the worker on specs that skip validation (http to a local counter, absolute path, `file:` URL, relative URL, image mark, link): no request, no read |
| A chart spec runs code, hangs or exhausts the channel | Interpreted expressions in a separate, killable process with caps | **Implemented (F11, ADR 0014).** `vega.parse(..., { ast: true })` and `vega-interpreter`, never `Function` codegen; `Function`, `eval`, `fetch` and the function constructors are replaced with throwing stubs in the worker. A `bun --smol` child per chart with an empty environment (no token), the scratch directory as cwd, a 20 s kill, one chart at a time (`busy`), a 64 KiB result cap. Caps: 200,000-byte spec, 5,000 rows, 60,000 nodes, depth 32, 2,000-character strings, 2,000 px sides, 12 MP, 20 MB PNG. The channel never imports the libraries |
| A secret leaves through a chart | Text is redacted before it becomes pixels | **Implemented (F11), accepted residual.** `RedactingChartRenderer` (built only in `buildOutbound`) redacts every string and key of the spec before the worker sees it, and reports the count. The caption goes through the image pipeline. Numbers are not redacted, and the image says the rest bypasses redaction |
| A prompt injection persists itself in `CLAUDE.md` | Only lines the owner approved by button are written, by the bridge, exactly as shown | **Implemented (F12, ADR 0015).** `propose_memory`: 1 to 8 single lines of at most 300 code points, no controls, bidi, zero-width, code fences or HTML comments. Sent with `redaction: 'refuse'` and `overflow: 'refuse'`, so what is approved is exactly what is shown. Approve and Reject (`m1:`) only after `ButtonTapHandler`'s checks; never a permission verdict. CAS state machine, 30-minute expiry, owned by the polling session. The bridge appends under `## Session notes` with a temp file and rename, refusing links out of the project, non-regular files, files over 1 MB and concurrent changes |
| Claude edits memory or settings files directly | Such edits are high risk and need a second tap | **Implemented (F12).** `RiskPolicy` rules `memory_file_edit` (`Write`, `Edit`, `MultiEdit`, `NotebookEdit` on `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` or under `.claude/`, any case, either separator, 8.3 names, trailing dots, streams) and `memory_file_write` (redirections, `tee`, `cp`/`mv`, PowerShell writers, `ln`, `sed -i`/`perl -i`). A heuristic: a script that writes the file is not recognized |
| A session summary escapes the project or overwrites a file | A bridge-made name, exclusive create, containment | **Implemented (F12, ADR 0015).** The name is `<UTC stamp>-<slug>.md` from a pure slug function; `wx` create (never overwrites, never follows a link at the name) with numeric suffixes; `docs` and `sessions` checked level by level, and a symlink or junction resolving outside the project refuses the save; 200,000 bytes; controls stripped. The chat copy is redacted, the local file is not (the notice says so) |
| Claude is steered into messaging other chats | The `reply` tool only accepts the private chat of a currently allowlisted sender | **Implemented (F2).** `src/application/use-cases/SendReply.ts` checks the live allowlist on every call (revocation is immediate), refuses anything else with an MCP error result and audits `reply.refused`. Plain text only (no `parse_mode`) and link previews disabled, so Claude's output cannot carry markup or hidden links |
| Flooding the bot | Per-sender rate limit; throttled logs | **Implemented (F2).** `RateLimitStep` (token bucket, burst 20, 1 message / 3 s, one notice per minute, audited) after authentication; the drop log lines for strangers and non-private chats are throttled to one per sender (or chat) per minute with a suppressed count (`src/domain/EventThrottle.ts`) |
| Approving something destructive by mistake | `RiskPolicy` detects patterns such as `rm -rf`, `git push --force` or `DROP` and asks for a second tap. A heuristic second tap, not a sandbox | **Implemented (F3, extended by L1).** `src/domain/permissions/RiskPolicy.ts` (about 40 rules over `input_preview`, erring towards high; an elided or unserializable preview is high). Since L1 it also covers the bridge's own state (brake, hook key, token, database) and CLI, Claude Code's settings, hooks, plugins and MCP config, `rm` with wildcards, `find -exec rm`, `shred`, `truncate -s 0`, destructive git (`branch -D`, `checkout .`, `stash drop`, `reflog expire`, `filter-repo`, push `--mirror`/`--delete`/`:ref`), PowerShell and Windows deletes and disk tools, inline code (`python -c`, `node -e`, `bash -c`, `pwsh -EncodedCommand`...), download-then-run, the environment sent to the network, mass kills, `terraform destroy`/`kubectl delete`/`aws s3 rm`/`docker prune`/`gh repo delete`, package publishing and `UPDATE` without `WHERE`. Command rules are linear scans over tokens and every regex is bounded (L2; `tests/domain/regexBudget.test.ts`). High risk needs Approve then Confirm within 30 s (`awaiting_confirmation` in `PermissionRequest`); a text `yes <id>` cannot approve it |
| Stale or double-tapped button | Each button carries the `request_id` from Claude Code; the state machine refuses to resolve twice; the keyboard is removed on resolution | **Implemented (F3).** Button data `p1:<id>:<action>` parsed strictly (`src/application/permissions/callbackData.ts`). `ResolvePermission` stores the decision with compare-and-set before sending the verdict, so a double tap or a racing expiry yields one verdict; every copy is edited and loses its buttons. Expired, resolved and other-session requests answer with a toast and change nothing |
| Misleading text in a permission preview | `description` and `input_preview` are shown as escaped plain text, without formatting or links, and never cut silently | **Implemented (F3, M2).** Prompts are plain text (no `parse_mode`) with link previews disabled and redacted by `RedactingPromptGateway`. A prompt that does not fit one message once redacted is sent as its whole description and input in plain messages first (redacted, chunked), then the buttons, whose message keeps the request id, tool and risk and says the details are above. If those messages cannot be sent, the button message elides the middle, says how many characters are not shown, and the request becomes high risk (`input_not_shown` in the audit). Edits of a long prompt say how much they leave out. Telegram still auto-links bare URLs |
| Spoofed names in prompts and confirmations | Display names and usernames are sanitized at the boundary and at render time | **Implemented (M5).** `src/domain/displayText.ts` removes controls, escape sequences, bidi overrides and invisible characters, collapses whitespace and caps the length; usernames must match Telegram's shape. The pairing confirmation at the terminal shows the numeric id first on its own line, then the quoted name and the @username on labelled lines |
| A web page or another local process drives the dev listener | Random bearer token, no browsers, loopback only, off with a bot | **Implemented (M4).** `TELEGRAM_BRIDGE_DEV_PORT` binds `127.0.0.1` only; every request needs `Authorization: Bearer <token>` (32 random bytes per start, printed once to stderr with ready-to-paste `curl` lines, never logged, compared in constant time); any `Origin` header and any `Host` other than `127.0.0.1:<port>`/`localhost:<port>` is refused with 403 (cross-origin POSTs and DNS rebinding), on `POST /` and `GET /events` alike. It never starts when a bot token is configured, and a malformed port is logged, not fatal (`src/adapters/dev/`). A local process of the same user that can read the server's stderr can still use it |
| Another local process writes to the hooks socket | Socket with mode 0600 inside the user's directory | **Implemented (F4, ADR 0008).** Unix socket `<stateDir>/hooks.sock`, chmod 0600 inside the 0700 state directory (or a short fallback directory that both sides require to be owned by the user and 0700); a named pipe on Windows. Every frame carries an HMAC-SHA256 over its JSON with a 32-byte secret from `<stateDir>/hooks.key` (0600), verified in constant time, so the secret never travels. Frames are size-capped (256 KiB), time-limited (2 s) and bounded in number; rejected ones are counted and logged by reason only. Only the poller listens; never a network socket (`src/adapters/ipc/`) |
| Claude does something harmful and must be stopped now | Panic button `/stop`: a brake flag checked by a `PreToolUse` hook before every tool call, pending permission requests denied, best-effort interrupt; `/resume` releases it | **Implemented (F6, ADR 0003).** `<stateDir>/brake.json` (0600, atomic) read by `src/brakeHook.ts` (synchronous, every tool, node builtins only), which prints `continue: false` plus a `deny`. Missing flag: not braked; present but unreadable: braked. `StopSession` denies every open request of this session once via `ResolvePermission`. While braked, chat messages are not forwarded, new requests are denied unrelayed, and approvals are refused. Escape via `tmux send-keys` only inside tmux and not on Windows (Linux, macOS since F5) (pane id validated, argument array, timeout). `bun run bridge -- stop`/`resume` at the terminal. Only an allowlisted sender can trigger it |
| No record of what was approved | Append-only audit: who, when, what and which verdict | **Implemented (F1-F3).** `audit_log` table with triggers that reject `UPDATE` and `DELETE` (`src/adapters/storage/sqlite.ts`); no update or delete API (`SqliteAuditLog`). Every pairing and allowlist change is audited, without codes, tokens or message text. F2 adds `message.forwarded` (sender id, message id, length), `message.rate_limited`, `reply.sent` (chat id, parts, redaction count), `reply.refused`, `reply.failed`; never message text or secret values. F3 adds `permission.relayed` (tool, risk, rule ids), `permission.confirmation_requested`, `permission.approved` and `permission.denied` (who, tool, risk, button or text), `permission.verdict_failed`, `permission.expired`, `permission.resolved_locally`; never the description or the input. F6 adds `brake.engaged` (actor, reason length only), `session.stopped` (requests denied, interrupt result), `brake.released`, and `permission.denied` with `via: stop` or `via: brake`. F5 adds `screenshot.sent` and `screenshot.not_sent` (actor, chat id, kind, host only, bytes, photo or document, reason); never the URL's path or query, the caption or an error text. F7 adds `choice.asked` (id, chat, number of options), `choice.refused`, `choice.answered` (id, button or text, option index) and `choice.expired`; never the question or the labels. F10 adds `attachment.received` and `attachment.refused` (sender id, photo or document, size, extension, sniffed type, reason); never the file name or the caption. F8 adds `git.diff_sent` and `git.diff_not_sent` (actor, chat id, filtered or not, files, bytes, cut, redaction count, reason) and `git.action_requested` (commit, revert or pr); never a path, a branch name or diff content. F9 adds `status.pinned` and `status.unpinned` (chat id). F11 adds `chart.sent` and `chart.not_sent` (chat id, spec bytes, rows, outcome, photo or document, bytes, width, height, redaction count, reason); never the spec, the caption or the renderer's message. F12 adds `wrap.requested` (chat id), `session.summary_saved` (chat id, bytes, notified) and `session.summary_not_saved` (reason), `memory.proposed` (id, chat id, line count, characters), `memory.refused`, `memory.approved` and `memory.rejected` (id, line count), `memory.write_failed` and `memory.expired` (reason); never the summary or the lines |

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
- **Busy state is unknown.** (Superseded by F4.) In F2 the bot could not tell whether Claude was
  mid-turn, so it never said "queued"; events still queue in the session (ADR 0005). Since F4,
  hooks feed `SessionActivity` (`TrackSessionActivity`) and the "queued" note appears while
  Claude is busy; without hooks it stays `unknown`.

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
- **Answered at the terminal.** (Narrowed by F4, see below.) Without a hook signal the phone keeps the buttons until expiry; a
  tap then shows "Approved" while Claude Code drops the verdict for the closed id. F4's
  `PostToolUse` hook narrows this: a tool that ran closes the matching prompt. A local denial
  still waits for expiry.

## Additional F4 notes

- **The hook runs in the user's session.** `src/hook.ts` imports only node builtins and fails
  open: exit 0, nothing on stdout, a 1.5 s hard deadline. It never creates the secret or the state
  directory, so a session where the bridge never ran is untouched. The fail-closed brake is F6
  (superseding "fails open" for `PreToolUse` while a brake flag exists).
- **Least data over IPC.** The hook forwards only the fields the channel uses, clamped. It never
  forwards the prompt text or `tool_response`.
- **Notices go out like replies.** They go through `buildOutbound()` (redaction, then chunking),
  to allowlisted senders only, fitted to one message after redaction (M3). Audit rows carry the
  event and the length, never the text. A notice contains up to one Telegram message of Claude's
  final message (start and end); the hook forwards at most 32,768 characters of it, cut at the end.
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
- **Prompts left open by `bun run bridge -- stop`.** The CLI cannot reach the channel's prompts.
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
- **Busy and size limits.** One capture at a time per channel process (it runs in the
  background since M1, so it never delays `/stop`; shutdown kills it and removes its files); images over 50 MB are
  not sent (the chat says so), so a capture cannot be used to exhaust disk or upload.
- **Wayland dialogs.** Some compositors ask the person at the PC before a capture; the request
  times out after 20 s if nobody answers.

## Additional F7 notes

- **What a choice can do.** Exactly what typing the label could do: it becomes a message from
  the owner in the session. It cannot approve a tool call, release the brake or run a command of
  the bot. Claude decides the question and the labels; a label that reads like an instruction
  ("Approve and push") is still only text sent back to Claude, and the permission prompt for
  whatever Claude does next still applies.
- **Labels are never cut.** A label over 64 characters is refused rather than truncated, so two
  options cannot be made to look the same; labels must also differ ignoring case.
- **At rest.** The question and labels stay in `bridge.sqlite` only while the choice is open.
- **Skills come from disk.** Anyone who can write a `SKILL.md` in the project or the user's
  skills directory can add a button; that person can already change what Claude does in that
  project. The name rule keeps the button's text to one plain token.

## Additional F10 notes

- **The owner's files are trusted like the owner's text.** A file from the allowlisted account
  carries the same authority as a message from it. The controls are about what the bridge
  writes to disk and what it hands to Claude, not about judging the owner's intent. Anyone who
  controls the owner's Telegram account can also send files; the F3 account-takeover note applies.
- **What the limits protect.** The type checks stop a file from being saved or presented as
  something it is not (an executable renamed `.txt`, a script named `.png`), and stop path
  tricks in names. The size, budget and retention limits bound disk use and download time.
- **What they do not protect.** A valid PDF or image can still exploit a bug in whatever opens it,
  and a valid text file can contain instructions aimed at Claude (prompt injection). Claude reads
  attachments only when it decides to, with its normal tools and permissions; files are never
  executed by the bridge. A forwarded file is not inspected for malware.
- **Ordering.** A download finishes in the background, so a file can reach Claude after a text
  sent later.
- **Windows.** File modes are not enforced; the inbox inherits the user-profile ACL of the state
  directory.

## Additional F8 notes

- **What a button can do.** Exactly what typing the instruction could do. "Commit" does not commit:
  Claude reads the instruction, decides how to do it, and asks permission for each command. The
  owner can deny there. A button cannot approve anything, release the brake or skip the risk
  rules. The commands a revert needs (`git checkout .`, `git restore .`, `git reset --hard`,
  `git clean -f`) are high risk in `RiskPolicy` and need a confirm tap; a plain `git push` is
  normal risk, so Open PR relies on the ordinary approval.
- **Reading is not free of risk.** Running git at all trusts the git binary on `PATH` and the
  owner's global configuration (kept on purpose: it is the owner's). The repository's own
  configuration is the untrusted part, and it is what the flags neutralize. A new git setting
  that starts a program and is not covered would not be blocked; add it to
  `gitInvocations.ts` and its tests.
- **Git LFS.** Filter drivers are disabled, so LFS files show as pointer text.
- **Instruction routing.** The instruction goes through the text chain. If a typed "Other…" answer
  is pending (F7), it is taken as that answer; a rate-limited instruction is dropped while the toast
  still says "sent" (both as with skill taps).

## Additional F9 notes

- **Why not let Claude write it.** A status written by Claude shows what Claude says; one fed by
  hooks shows what Claude Code did. A steered Claude cannot put text in the pinned message: the only
  free text that reaches it is a shell tool's `description`, cut to 60 characters, sanitized and
  redacted.
- **At rest.** Only the message id per chat is stored (`status_messages`); the content is rebuilt
  from memory.
- **Several sessions.** Only the polling process edits; another session's activity is not shown
  (F14).

## Additional F11 notes

- **Two layers, independent.** Validation refuses external resources so Claude gets a precise
  error; the worker refuses them again, so a gap in validation does not become a fetch.
- **Not a sandbox.** The worker is a process of the same user. It holds no secrets (empty
  environment, a redacted spec) and can load nothing, but a memory-safety bug in the engine or in
  resvg would run with the user's rights until the 20 s kill.
- **Fonts.** Only the bundled Noto Sans Latin subsets are given to resvg; system fonts are never
  read.

## Additional F12 notes

- **Why the bridge writes.** If Claude wrote `CLAUDE.md` after an approval, the approval would
  only be a suggestion: a steered Claude could write something else. The bridge writes exactly the
  approved lines and nothing else.
- **Brake.** An approval while braked still writes (the owner's own act) but tells Claude nothing.
- **No automatic wrap.** A `SessionEnd` hook has no decision control and its output is
  discarded, so it cannot make Claude summarize; nothing runs at session end.
- **The summary file is not redacted.** It sits in the project and may be committed; only its chat
  copy goes through redaction.

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

## Additional audit-hardening notes

- **`/stop` never queues behind slow work (M1).** The poller hands each update to a lane (per chat;
  `/stop` and `/resume` and button taps have their own) and keeps polling; a chat's ordinary
  messages stay in order. `/shot` answers "capturing" and runs in the background. `StopSession`
  engages the brake before anything is awaited, then sends the denials and the interrupt at once,
  and the Telegram gateway has no global send queue, so a flood wait on one message holds up no
  other. Updates are confirmed to Telegram only once handled (or when more than 50 are pending), so
  a crash redelivers rather than loses them; on shutdown the poller waits up to 1.5 s for handlers.
  Residual: `RateLimitStep` still applies to `/stop`, so a sender who already spent the burst
  (20 messages) waits up to 3 s; the stop report itself goes out after the denials' prompt edits.
- **Bounded input (L2).** Permission fields over 8,192 UTF-16 units (Claude Code sends at most
  3,500 code points) are ignored; a `reply` text over 64 KiB is an error result; an inbound text
  over 16,384 characters is refused and the sender told.
- **State directory (L3).** A relative `TELEGRAM_BRIDGE_HOME` or `CLAUDE_CONFIG_DIR` is refused,
  never resolved against the working directory (the channel, the CLI and the hooks run in different
  ones), so every entry point ends at the same directory or fails loudly; the brake hook falls back
  to the default directory so a brake there is still honored.
- **Hook key (L4).** `hooks.key` is created with an exclusive create (`wx`, 0600); a concurrent
  creator waits for the winner's key instead of overwriting it.
