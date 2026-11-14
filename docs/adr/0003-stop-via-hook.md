# ADR 0003: The panic button is enforced by a PreToolUse hook

- Status: Accepted, built in F6 (mechanism refined by ADR 0005)
- Date: 2026-11-13; updated 2026-11-14 with the design as built
- Sources: hooks reference <https://code.claude.com/docs/en/hooks>, re-fetched 2026-11-14
  (PreToolUse decision control, JSON output, exit codes, "Block the action when a hook fails",
  "Run hooks in the background")

## Context

`/stop` must halt Claude quickly. Channel events cannot do it: the channels reference says events
queue into the session and are delivered on the next turn while Claude is busy, so a "stop"
message is only read after the work it should have stopped. The plan's interrupt via
`tmux send-keys Escape` only works inside tmux, which does not exist on Windows.

## Decision

- **Flag.** `/stop` (or `telegram-bridge stop` at the terminal) writes `<stateDir>/brake.json`:
  `{"v":1,"engagedAt":<ms>,"actor":"telegram:<id>"|"terminal","reason"?:"..."}`, mode 0600,
  atomically (temp file + rename). A file, not a SQLite row, so the hook reads it with one
  `open` and node builtins only. `/resume` or `telegram-bridge resume` deletes it.
- **Hook.** `hooks/hooks.json` registers `bun ${CLAUDE_PLUGIN_ROOT}/src/brakeHook.ts` on
  `PreToolUse` without a matcher (every tool, the bridge's own `reply` included: Claude is
  stopped), synchronous (`async` would make its decision void, per the docs), `timeout: 5`.
  It does not read stdin and does no IPC.
  - No flag: exit 0, nothing on stdout. Measured on the dev box (Windows 11, Bun 1.4.4, median
    of 20): 27 ms, against 20 ms for `bun -e 0`.
  - Flag engaged: exit 0 and exactly one JSON object:
    `{"continue":false,"stopReason":"...","hookSpecificOutput":{"hookEventName":"PreToolUse",
    "permissionDecision":"deny","permissionDecisionReason":"..."}}`. `continue: false` stops
    Claude ("takes precedence over any event-specific decision fields"; for `PreToolUse` "the
    stop applies even when the tool call fails or completes while Claude is still streaming");
    the deny refuses this call even on its own. `stopReason` is shown to the user and tells them
    the brake came from Telegram (or the terminal) and how to release it;
    `permissionDecisionReason` is what Claude reads. Median 37 ms (it loads the catalog).
- **Channel side.** `StopSession` engages the flag, sends `deny` for every pending permission
  request of this session through `ResolvePermission` (one verdict each; the prompts lose their
  buttons and say "denied by /stop"), then asks the `SessionController` to interrupt the turn.
  While the flag is set: chat messages are not forwarded (`BrakeGateStep`, one notice per minute),
  new permission requests are answered `deny` at once and not relayed, approvals of prompts left
  open (after `telegram-bridge stop`) are refused, and `/status` shows the brake.
- **Interrupt.** `TmuxSessionController` runs `tmux send-keys -t <pane> Escape` (argument array,
  pane validated as `%<digits>`, 2 s timeout) only on Linux when the channel inherited `TMUX` and
  `TMUX_PANE` from Claude Code's pane. Everywhere else `NoopSessionController` reports
  `unavailable`, and the chat says "Claude will stop at its next tool call". No keystroke
  injection on Windows or macOS.

## Failure policy

- **Missing flag file: not braked (fail open).** Also when the state directory does not exist or
  cannot be resolved. A broken or partial install must not brick every session.
- **Flag file present but unreadable, oversized or not a valid record: braked (fail closed).**
  Someone asked to stop. The `stopReason` then names the file and says to run
  `telegram-bridge resume` or delete it. Any error opening the file other than "does not exist"
  counts as present. If the catalog cannot be loaded the hook still prints a fixed English
  deny-and-stop object.
- **`onFailure: "continue"`.** It applies when the hook process itself fails: `bun` missing from
  `PATH`, the script missing after an update, a crash, the 5 s timeout. With `"block"` any of
  those would refuse every tool call in every session, which is the bricking this policy avoids.
  Being explicit also pins the behavior on Windows, where the docs say a failing hook can block
  when Git Bash is missing (that note is about shell form; ours is exec form). The trade-off: a
  broken hook does not brake. `onFailure` needs Claude Code v2.1.295+; older versions behave as
  `continue` by default. **Needs live verification**: that an older Claude Code ignores the
  unknown key rather than rejecting the hook.

## Consequences

- The brake works on every OS and without a terminal multiplexer.
- Text generation already in progress is not cut, except inside tmux on Linux; the next tool call
  is. After `/resume` Claude does not continue by itself: the next prompt (terminal or chat)
  starts a new turn.
- The hook runs on every tool call, so it must stay fast and must not depend on the channel
  process being alive (it reads the flag from disk). The flag is global to the state directory:
  every session that uses this state directory is braked.
- The hook-to-channel IPC (ADR 0008) is not involved.
