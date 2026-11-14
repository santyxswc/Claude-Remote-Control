# ADR 0006: Single-poller lock as a heartbeated row in the state database

- Status: Accepted
- Date: 2026-11-13

## Context

Telegram delivers a bot's updates to one `getUpdates` consumer at a time; a second consumer gets
`409 Conflict` (ADR 0005 (a)). Two of our processes may want to poll the same bot:

- the channel process (`src/main.ts`), spawned by Claude Code for each session, and possibly left
  behind as an orphan after a crash;
- the `pair` CLI command, which needs someone to receive `/start <code>` while it waits.

`pair` must therefore know whether a live channel process is polling (then it only watches the
database for the claim) or not (then it polls itself for the duration of the pairing). The
reference plugin uses a `bot.pid` file and kills a stale holder after checking its command line
with `ps`, which is Unix-only.

The brief for F1 asked for a lock in the state directory with pid, start time and stale-lock
detection when the pid is dead, working on Windows and Unix.

## Decision

- The lock is the single row of the `poller_lock` table in `<stateDir>/bridge.sqlite`
  (`src/adapters/storage/SqlitePollerLock.ts`), holding `pid`, `role` (`channel` or `cli`),
  `started_at` and `heartbeat_at`.
- `tryAcquire` runs in a `BEGIN IMMEDIATE` transaction: read the row, and take it only if it is
  absent, ours, or stale. SQLite serializes this across processes, so two processes cannot both
  see a stale lock and both take it (a lock file offers no atomic check-and-replace; `O_EXCL`
  creation plus deleting a stale file races).
- A holder is stale when its pid is dead (`process.kill(pid, 0)`: works on Windows and Unix,
  `EPERM` counts as alive) or when its heartbeat is older than 60 s. The heartbeat (every 10 s)
  also covers pid reuse without inspecting other processes' command lines.
- We never kill another process. A live holder simply wins; the channel retries every 30 s
  (`PollingSupervisor`), and a holder that finds its heartbeat refused (someone took over after
  it stalled, e.g. a suspended laptop) stops polling.
- The poller itself still treats a persistent `409` as fatal after a few backed-off retries, to
  cover pollers outside our lock (another machine, the reference plugin).

## Consequences

- The lock shares the database's durability and locking; no extra file to clean up.
- A crashed holder blocks polling for at most 60 s on a recycled pid, immediately otherwise.
- A process that hangs for more than 60 s while alive can lose the lock to another one; the
  first heartbeat after it resumes detects this and stops its polling, and Telegram's own 409
  guards the overlap.
- An orphaned channel process that keeps heartbeating keeps the bot. Exit on stdin EOF (F0)
  remains the main defence against orphans.
