# ADR 0007: Permission requests belong to the process that polls

- Status: Accepted
- Date: 2026-11-13

## Context

Every Claude Code session spawns its own channel process, and all of them share `bridge.sqlite`.
Only one of them polls Telegram (ADR 0006), so only that one receives button taps. A verdict sent
by one process reaches only the session that spawned it. The F3 brief asked to expire leftover
requests "once at startup", but with two live sessions a starting process would expire the open
requests of the one that is actually polling.

## Decision

- Each channel process has a random session id; every stored request records the session that
  relayed it.
- A process relays a permission request only while it holds the poller lock. Otherwise it sends
  nothing, and the request is answered at that session's terminal.
- `ResolvePermission` acts only on requests of its own session; anything else is "not found".
- Each time a process takes the poller lock it expires the open requests of other sessions
  (`ExpirePermissions.expireOrphans`) and removes their buttons. At a normal start (nobody else
  polling) this is exactly "expire the leftovers of the previous process".

## Consequences

- No tap can ever produce a verdict addressed to the wrong session, and no process expires
  requests that another live process can still resolve.
- With two sessions open, only the polling one gets prompts on the phone. This matches the MVP's
  "one bot, one session"; F14 (daemon) changes the routing.
- A stored row of a closed request from an earlier session does not block a new request that
  happens to reuse its id.
