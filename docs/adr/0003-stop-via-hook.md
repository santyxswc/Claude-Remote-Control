# ADR 0003: The panic button is enforced by a PreToolUse hook

- Status: Accepted (mechanism refined by ADR 0005)
- Date: 2026-11-13

## Context

`/stop` must halt Claude quickly. Channel events cannot do it: the channels reference says events
queue into the session and are delivered on the next turn while Claude is busy, so a "stop"
message is only read after the work it should have stopped. The plan's interrupt via
`tmux send-keys Escape` only works inside tmux, which does not exist on Windows.

## Decision

- `/stop` sets a brake flag in the bridge's state directory.
- A `PreToolUse` hook shipped by the plugin checks the flag before every tool call. While the
  flag is set it refuses the call and ends the turn (exact output shape in ADR 0005).
- The channel also denies any pending relayed permission requests.
- `/resume` clears the flag.
- Interrupting a turn that is only generating text (no tool calls) is a best-effort extra, never
  the guarantee.

## Consequences

- The brake works on every OS and without a terminal multiplexer.
- Text generation already in progress is not cut; the next tool call is.
- The hook runs on every tool call, so it must be fast and must not depend on the channel process
  being alive (it reads the flag from disk).
- The hook-to-channel IPC in the plan was a Unix socket; that must be generalised for Windows
  (for example a loopback endpoint with a token, or a named pipe) when F4 is built. Done in F4:
  a Unix socket or a named pipe with an HMAC per frame (ADR 0008). The brake hook itself reads its
  flag from disk and does not use that IPC.
