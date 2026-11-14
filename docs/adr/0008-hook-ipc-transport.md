# ADR 0008: Hooks reach the channel over a Unix socket or a named pipe, with an HMAC

- Status: Accepted
- Date: 2026-11-14
- Refines: the plan's "Hooks ↔ canal: socket Unix con permisos 0600" and ADR 0003's note that
  the IPC "must be generalised for Windows when F4 is built".

## Context

Claude Code runs hook commands as short-lived processes inside the user's session (hooks
reference, re-fetched 2026-11-14). F4 needs each `Stop`, `Notification`, `UserPromptSubmit` and
`PostToolUse` event to reach the long-running channel process, which is the only one that can talk
to Telegram. The plan chose a Unix socket with mode 0600 and named HTTP on `127.0.0.1` with a
token as the alternative. Windows is a first-class target, the hook runs on every matching event,
and it must never slow down or break the session.

Verified on the dev box (Windows 11, Bun 1.4.4) with a real client and server: `node:net` named
pipes work (`\\.\pipe\...`, a round trip of about 8 ms in a probe script; a second listener on
the same name gets `EADDRINUSE`; after close, a client gets `ENOENT`). `AF_UNIX` paths do not
listen under Bun on Windows. Unix sockets are exercised by the POSIX-only tests on CI's ubuntu
runner; Docker was not available to run them locally.

## Decision

- **Transport, per OS** (`src/adapters/ipc/endpoint.ts`):
  - Linux and macOS: a Unix domain socket `<stateDir>/hooks.sock`, chmod 0600 after binding,
    inside the 0700 state directory. `sun_path` holds 104 (macOS) or 108 (Linux) bytes, so a
    path longer than 100 bytes falls back to `<XDG_RUNTIME_DIR or tmpdir>/telegram-bridge-<hash>/hooks.sock`.
    `<hash>` is the first 16 hex digits of SHA-256 of the state directory. That directory is
    created 0700, and both sides refuse to use it unless it is a real directory owned by this uid
    with no group or other bits. This guards against someone pre-creating the name in a shared
    `/tmp`.
  - Windows: a named pipe `\\.\pipe\telegram-bridge-<hash>`, hashing the lowercased path.
  - Never TCP or any network socket. The HTTP fallback was not needed.
- **Authentication**: a 32-byte secret, created on first listen with the OS CSPRNG and stored
  as hex in `<stateDir>/hooks.key` (0600, atomic write). Each frame carries
  `HMAC-SHA256(secret, json)`, not the secret itself, and the server compares it in constant time
  (`timingSafeEqual`). A process that squats the endpoint therefore learns nothing it could
  replay against the real listener later. Pipe ACLs are not managed, so on Windows this MAC is the
  main protection against forged events.
- **Framing** (`frame.ts`): one connection carries one line,
  `tb1 <base64url mac> <json>\n`, capped at 256 KiB. The server answers `k` and closes. Oversize,
  unauthenticated or malformed frames, clients that stall for more than 2 s, and frames beyond
  64 pending events are dropped. Drops are counted per reason, and a throttled log line names
  only the reason. Events reach the use cases one at a time, in arrival order.
- **Who listens**: only the poller-lock holder (ADR 0006), via `PollingSupervisor`'s
  `onPollingStarted` and the new `onPollingStopped`. A process that finds the endpoint held by a
  live listener retries every 10 s while it polls (the previous holder stops listening once its
  heartbeat notices the lost lock).
- **Stale sockets**: a socket file is unlinked only when it is a socket and a probe connect gets
  `ECONNREFUSED`/`ENOENT` within 300 ms. On stop the server removes the file only if its inode is
  still the one it bound, never a newer listener's.
- **Client** (`src/hook.ts`): imports only node builtins and the small zod-free modules above. No
  secret file means the bridge never ran here, so the hook exits without connecting or creating
  anything. The hook forwards only the fields the channel uses, clamped, never the prompt text or
  `tool_response`. It gives up after 1 s waiting for the ack and exits 0 by 1.5 s whatever happens,
  with nothing on stdout. Measured cold start on the dev box: about 33 ms without a secret and
  about 42 ms for a full send plus ack, against 19 ms for `bun -e 0`.

## Consequences

- Hook events cannot be forged by another local process without reading the user's own 0600
  key file.
- On Windows another local user could create the pipe name first, before the channel starts. Such
  a process would receive hook payloads (the last assistant message, notification text, the start
  of tool inputs) but not the secret. Our listener would then report `in_use` and notices would not
  work. Mitigating that needs a pipe DACL or server authentication; it is accepted for the MVP,
  where the PC has one user.
- A crash leaves a socket file behind; the next listener replaces it. On Windows pipes vanish with
  the process.
- The key is never rotated; deleting `hooks.key` while the channel is stopped makes a new one.
