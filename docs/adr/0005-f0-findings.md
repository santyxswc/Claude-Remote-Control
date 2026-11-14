# ADR 0005: F0 findings on the channel contract, hooks, plugins and the Bot API

- Status: Accepted
- Date: 2026-11-13
- Sources fetched on 2026-11-13 (channels are a research preview; re-check before relying on
  details):
  - Channels reference: <https://code.claude.com/docs/en/channels-reference>
  - Channels: <https://code.claude.com/docs/en/channels>
  - MCP: <https://code.claude.com/docs/en/mcp>
  - Hooks reference: <https://code.claude.com/docs/en/hooks>
  - Plugin manifest reference: <https://code.claude.com/docs/en/plugins-reference> (served as
    "Plugin manifest reference", canonical path `/docs/en/plugins/manifest-reference`)
  - Interactive mode: <https://code.claude.com/docs/en/interactive-mode>
  - Reference plugin: `external_plugins/telegram` in `anthropics/claude-plugins-official`
    (`server.ts`, `.mcp.json`, `.claude-plugin/plugin.json`, `package.json`)
  - Telegram Bot API 10.4 (2026-11-09): <https://core.telegram.org/bots/api> and
    <https://core.telegram.org/bots/features#deep-linking>

Legend: **Verified in docs** means the quoted source states it. **Needs live verification**
means the docs are silent or only imply it; the owner must check it in an interactive session.

## Context

`docs/plan.md` ("A verificar en F0") lists unknowns that must be answered before F1. F0 also asked
how `permission_request` arrives. Nothing here was observed in a live Claude Code session; the
local tests only exercise our server against the MCP SDK client.

## Findings

### (a) One channel process per session?

- **Verified in docs** (channels-reference, "Overview" and step 3): "Claude Code spawns it as a
  subprocess and communicates over stdio" and "Claude Code reads your MCP config at startup and
  spawns each server as a subprocess."
- **Verified in docs** (channels-reference, "Notification format"): "To process independent
  event streams concurrently, run separate sessions." Events from one server go to the session
  that spawned it.
- **Verified in docs** (channels, "Security"): "Being in `.mcp.json` isn't enough to push
  messages: a server also has to be named in `--channels`." And (channels, "Enterprise
  controls"): when channels are not enabled, "the MCP server still connects and its tools work,
  but channel messages won't arrive."
- **Verified in docs** (channels-reference): notifications are not acknowledged; "If the session
  hasn't loaded your server as a channel ... Claude Code drops the events silently and returns no
  error to your server."
- **Needs live verification**: that two `claude` sessions in the same project start two
  independent `bun src/main.ts` processes, and what happens on `/mcp` reconnect or `--resume`.
  The reference plugin's comments describe exactly this: a second session or an orphaned process
  makes `getUpdates` fail with 409 Conflict, and it kills a stale poller via a PID file and shuts
  down on stdin EOF.

Implications: the plan's "one bot, one session" constraint stands. In F2 the process must not
poll Telegram unless it is really registered as a channel, but the server cannot detect that
(no acknowledgement). Mitigations to decide in F2: a PID/lock file in the state directory, exit
on stdin EOF (already implemented in `src/main.ts`), and documenting that the server also starts
in sessions launched without the channel flag.

### How `permission_request` arrives (plan F0 step 4)

- **Verified in docs** (channels-reference, "Relay permission prompts"): the server must declare
  `capabilities.experimental['claude/channel/permission']: {}` (opt out by omitting it or `false`;
  before v2.1.234 `false` counted as declared). Since v2.1.234 requests go only to servers
  registered as channels for the session.
- Claude Code sends the notification `notifications/claude/channel/permission_request` with four
  string params: `request_id` ("Five lowercase letters drawn from `a`-`z` without `l`"),
  `tool_name`, `description`, `input_preview`.
- The verdict is the notification `notifications/claude/channel/permission` with params
  `request_id` and `behavior` (`'allow'` or `'deny'`). "Neither verdict affects future calls."
  An unknown or reused ID is dropped silently.
- Since v2.1.211 `description` and `input_preview` are sanitized and capped at 3,500 code points
  (long values keep start and end around `⋯ N code points elided ⋯`); since v2.1.234 recognizable
  credentials are replaced by `[REDACTED]`. Project trust and MCP consent dialogs are never
  relayed.
- The terminal dialog stays open; "Claude Code applies whichever answer arrives first and closes
  the other." **Not in docs**: any notification telling the channel that a request was resolved
  at the terminal. The plan's F3 step 6 (clean up buttons via a `PostToolUse` hook or expiry)
  remains necessary; note that `PostToolUse` only fires when the tool ran successfully, so a
  local denial is only covered by expiry.

### (b) Hook names, stdin input fields, and how PreToolUse blocks

All **Verified in docs** (hooks reference). Event names are exactly `Stop`, `Notification`,
`PreToolUse`, `PostToolUse`. Command hooks receive JSON on stdin.

Common input fields: `session_id`, `prompt_id` (absent until the first user input),
`transcript_path`, `cwd`, `scratchpad_dir` (v2.1.257+, optional), `permission_mode` (not on all
events), `effort` (object with `level`, on `PreToolUse`, `PostToolUse`, `Stop` and others),
`hook_event_name`; `agent_id` and `agent_type` inside subagents or with `--agent`.

| Event | Event-specific input fields | Matcher |
| --- | --- | --- |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`; for MCP tools also `mcp_server` (`name`, `source`; v2.1.274+) | tool name |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, optional `duration_ms`; `mcp_server` for MCP tools | tool name |
| `Notification` | `message`, optional `title`, `notification_type` | `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, ... |
| `Stop` | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | none (always fires) |

Notes that affect later flows:

- `Stop` "Does not run if the stoppage occurred due to a user interrupt"; API errors fire
  `StopFailure` instead. Use `last_assistant_message` rather than reading `transcript_path`: "the
  transcript file isn't guaranteed to include the final message at Stop time". This contradicts
  plan F4 step 3 ("tomado de la transcripción").
- `Notification` with `permission_prompt` fires only after the prompt "has waited about six
  seconds" without typing; `idle_prompt` about 60 seconds after Claude finishes. For an
  immediate signal use the `PermissionRequest` hook (input `tool_name`, `tool_input`, optional
  `permission_suggestions`, no `tool_use_id`). Notification hooks cannot block anything.
- On Windows, file-tool paths in `tool_input` use backslashes; normalize before matching.
- `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` are substituted in
  `command`/`args` and exported as environment variables to the hook process.
- Prefer exec form on Windows: `"command": "bun", "args": ["${CLAUDE_PLUGIN_ROOT}/..."]`. Shell
  form runs through Git Bash, or PowerShell when Git Bash is missing; `.cmd`/`.bat` shims cannot
  run in exec form.

How a `PreToolUse` hook blocks a tool:

- **Exit code 2** blocks the call; stderr is the reason shown to Claude. Exit 1 (or any code other
  than 0 and 2) is a non-blocking error and the tool runs.
- **Or exit 0 with JSON on stdout** (nothing else on stdout):
  `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
  "permissionDecisionReason": "..."}}`. `permissionDecision` is `"allow"`, `"deny"`, `"ask"` or
  `"defer"` (`defer` only with `-p`); precedence across hooks is `deny` > `defer` > `ask` >
  `allow`. Top-level `decision`/`reason` are deprecated for this event.
- **Stopping Claude entirely**: the universal JSON field `"continue": false` (with
  `"stopReason"`) makes Claude stop processing after the hook; "For `PreToolUse` and
  `PostToolUse` hooks, the stop applies even when the tool call fails or completes while Claude
  is still streaming a response."
- A hook that crashes or times out does **not** block by default. `"onFailure": "block"`
  (v2.1.295+) makes failures block. Default timeout for command hooks is 600 s. On Windows
  without Git Bash, a failed shell-form `PreToolUse` hook may block regardless.

### (c) Plugin manifest structure

All **Verified in docs** (plugin manifest reference) unless marked.

- The manifest is `.claude-plugin/plugin.json` and is optional. `name` is the only required key
  (kebab-case); other keys include `displayName`, `version`, `description`, `author`
  (`name`, `email`, `url`), `homepage`, `repository`, `license`, `keywords`, `userConfig`,
  `channels`, `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`. Unknown
  top-level keys are stripped with a warning; unknown keys inside `userConfig`, `channels`,
  `lspServers` or `monitors` entries fail the load. `claude plugin validate <dir>` is the
  authoritative check.
- Standard layout at the plugin root (not inside `.claude-plugin/`): `skills/<name>/SKILL.md`,
  `hooks/hooks.json`, `.mcp.json`, `commands/`, `agents/`, `bin/` (on the Bash tool `PATH`).
- Hooks: `hooks/hooks.json` wraps the event map in a top-level `"hooks"` key (optional top-level
  `description`); a file without the wrapper fails to load. `plugin.json` `hooks` may also be a
  path, an inline event map (no wrapper), or an array of both, merged with `hooks/hooks.json`.
- MCP server: `.mcp.json` at the plugin root and/or `mcpServers` in `plugin.json` (path, inline
  map, or `.mcpb` bundle); a later name replaces an earlier one. The reference Telegram plugin
  uses `.mcp.json` with
  `"command": "bun", "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]`
  and a `start` script that runs `bun install` (to stderr) before the server.
- Channel declaration: `channels` is an array of strict objects with `server` (required, key in
  `mcpServers`), `displayName`, `userConfig`; saved values substitute into `${user_config.KEY}`
  in the server's `env`. The reference plugin's `plugin.json` does not use `channels` (only
  `name`, `description`, `version`, `keywords`).
- Variables: `${CLAUDE_PLUGIN_ROOT}` (installed version; changes on update, do not write state
  there), `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`, survives updates, deleted on
  uninstall by default), `${CLAUDE_PROJECT_DIR}`, plus `${user_config.KEY}`. For MCP stdio
  servers they resolve in `command`, `args`, `env` and are exported to the process.
- Components are namespaced under the plugin `name`. **Contradiction with the plan**: skills
  named `/bridge:init` require the plugin to be called `bridge`; with the agreed name
  `telegram-bridge` they will be `/telegram-bridge:init` (inferred from "Every component is
  namespaced under it"; **needs live verification** of the exact prefix).
- Development: a bare `.mcp.json` server is loaded with
  `--dangerously-load-development-channels server:<name>`; a plugin with
  `plugin:<name>@<marketplace>`. A plugin from our own marketplace still needs the development
  flag, since only `claude-plugins-official` (or an org `allowedChannelPlugins` list) is on the
  allowlist.
- **Not covered here**: the `SKILL.md` frontmatter format (documented on the skills and plugin
  components pages, not fetched in F0).

### (d) Ways to interrupt a running turn

- **Verified in docs** (interactive mode): `Esc` "Stop[s] the current response or tool call
  mid-turn"; `Ctrl+C` "Interrupts a running operation". Both are keyboard input to the terminal.
- **Verified in docs** (channels-reference): channel events cannot interrupt; they "queue into
  the session" and are "delivered together on the next turn".
- **Verified in docs** (hooks): from a `PreToolUse` hook, `"continue": false` stops Claude, and
  `permissionDecision: "deny"` or exit 2 refuses the tool call. From a `PermissionRequest` hook,
  `decision.behavior: "deny"` with `decision.interrupt: true` "stops Claude". `PostToolBatch`
  exit 2 "Stops the agentic loop before the next model call".
- **Not in docs**: any API (MCP notification, CLI command or signal) that lets the channel
  interrupt a turn that is only generating text. A permission `deny` verdict sent over the channel
  does not interrupt.
- **Needs live verification**: the exact effect of `"continue": false` from `PreToolUse` on an
  in-flight turn, and whether keystroke injection is feasible on Windows (no tmux).

Decision for F6 (refines ADR 0003): the brake hook returns `"continue": false` with a
`stopReason` (plus `permissionDecision: "deny"`) while the flag is set; tmux `send-keys` becomes
an optional Unix-only extra. This contradicts the plan's reliance on tmux for interruption.

### (e) Telegram Bot API limits (Bot API 10.4)

All **Verified in docs**:

- `callback_data` of an inline button: "1-64 bytes" (bytes, not characters).
- `sendMessage` `text`: "1-4096 characters after entities parsing"; media captions
  "0-1024 characters after entities parsing".
- Download via `getFile`: "The maximum file size to download is 20 MB"; the file link is valid
  for at least one hour.
- Upload: multipart "10 MB max size for photos, 50 MB for other files"; by URL "5 MB max size for
  photos and 20 MB max for other types of content".
- A local Bot API server lifts these: downloads "without a size limit", uploads "up to 2000 MB".
- Deep link `start` parameter: "A-Z, a-z, 0-9, _ and - are allowed ... The parameter can be up to
  64 characters long", base64url recommended. A 128-bit pairing code is 22 base64url characters,
  so the plan's `t.me/<bot>?start=<code>` fits.

## Other findings that affect the plan

- **MCP SDK version (contradiction risk, verified in MCP docs)**: Claude Code's v2 MCP client
  runtime "Doesn't register a channel server that connects on the newer revision" (2026-07-28).
  `@modelcontextprotocol/sdk` 1.32.2 supports protocol versions up to `2025-11-25`, so it is safe.
  We pin it exactly and a test asserts the SDK cannot negotiate `2026-07-28`. Do not move to SDK
  2.x until the docs say channels work on the new revision. Workaround for users:
  `MCP_PROTOCOL_NEGOTIATION=legacy`.
- **Meta keys**: "Keys must be identifiers: letters, digits, and underscores only. Keys
  containing hyphens or other characters are silently dropped." Our adapter rejects them loudly
  (and also rejects a leading digit, which the docs do not mention).
- **Plan F2 step 5** ("si Claude está ocupado ... responde 'en cola'"): the channel cannot know
  whether Claude is busy; `notification()` resolves when written to the transport. Busy state
  would have to come from hooks (for example `UserPromptSubmit`/`Stop`).
- **Environment for `.mcp.json` servers**: `${VAR}` and `${VAR:-default}` expand in `command`,
  `args` and `env`. Our `.mcp.json` forwards `TELEGRAM_BRIDGE_DEV_PORT` and
  `TELEGRAM_BRIDGE_HOME` explicitly, defaulting to empty (treated as unset).
- **Reference plugin state directory**: it honours `CLAUDE_CONFIG_DIR` (falling back to
  `~/.claude`). Our resolver does not yet; consider it in F1.

## Consequences

- F1 can start: the contract, hook schema, plugin layout and Telegram limits are known.
- The owner still has to run the manual checks in `docs/flows/F0.md` and the "needs live
  verification" items above in an interactive session on Windows.
