# ADR 0004: Local state in SQLite

- Status: Accepted
- Date: 2026-11-13

## Context

The bridge stores the allowlist of paired Telegram user IDs, pending pairing attempts, pending
permission requests and an append-only audit log. It is a single-user application on the user's
own PC; there is no server.

## Decision

- State lives in one SQLite database (`bun:sqlite`, WAL mode) inside the state directory.
- The state directory is `TELEGRAM_BRIDGE_HOME` when set, otherwise
  `~/.claude/channels/telegram-bridge` (resolved with `node:path`, so it works on Windows; since
  F1 `~/.claude` is replaced by `CLAUDE_CONFIG_DIR` when that is set, as in the reference plugin). The
  resolver is `src/adapters/storage/stateDir.ts`.
- The bot token is stored in a separate file in the same directory, outside the repository and
  never logged. On POSIX the directory is `0700` and secret files `0600`; on Windows file modes
  are not enforced, so the directory must sit under the user's profile.
- SQLite access is confined to adapters behind application ports (`PairingStore`,
  `PermissionStore`, `AuditLog`).

## Consequences

- One transactional file, no service to run, trivial backup and deletion.
- PostgreSQL or another server database is not justified for a single local user.
- Windows ACLs are not hardened by the code; this is a documented limit.
