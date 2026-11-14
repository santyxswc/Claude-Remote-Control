# F14 · Multi-project (work in progress, not merged)

This branch (`feat/f14-multi-project`) holds an unfinished and **unreviewed** implementation of
F14. Work was stopped on purpose before live validation of F0 to F13. Do not merge it as it is.

## The design it follows

- **Hub mode, opt-in.** One long-lived process, the hub (`bun run bridge -- hub`), owns the bot:
  it is the only `getUpdates` consumer and the only sender. Each Claude Code session's channel
  process is a spoke that talks to the hub over the authenticated local IPC of ADR 0008. With hub
  mode not configured, behaviour must stay exactly what `main` does.
- **One forum supergroup, one topic per session.** The hub creates or reuses a topic per project.
- **Routed by topic, authenticated by sender.** An update is accepted only when the chat is the
  registered group and `from.id` is in the allowlist. Group membership is never authentication.
- **No crossed messages.** The hub binds each spoke connection to one topic and stamps the thread
  id itself; a spoke cannot name another target.
- **Group binding** mirrors pairing: a one-time code sent in the group, confirmed in the terminal.
- **`/stop`** stays a global panic button handled by the hub itself.

## State when work stopped

| Check | Result |
| --- | --- |
| `tsc --noEmit` | passes |
| `bun run check:arch` | passes (326 files) |
| `bun test` | 2022 pass, 12 skip, 0 fail |
| `bun run lint` | **fails**: two errors in `tests/acceptance/F14.test.ts` and `tests/domain/hub/hubDomain.test.ts` |

Present: domain (`src/domain/hub`), application (`src/application/hub`, hub use cases and ports),
adapters (`src/adapters/hub`, `src/adapters/ipc/Hub*.ts`, `SqliteHubStores.ts`,
`TelegramGroupProbe.ts`, `hubCommands.ts`), composition (`src/composition/hub.ts`), and tests
including `tests/acceptance/F14.test.ts`.

Missing or unknown:

- The implementing pass was interrupted mid-edit; the last files it touched may be incomplete.
- No security review has been done of the routing invariants, the IPC protocol or the group binding.
- No flow brief (`docs/flows/F14.md`), no ADR, and no updates to the threat model, the
  architecture document, the READMEs or `CLAUDE.md`.
- It has not been checked that existing tests kept their meaning (several shared files changed:
  the poller, the gateway, the poller lock, `main.ts`).
- Nothing was tried against the real Telegram API.

## To resume

1. Validate F0 to F13 live first (`docs/flows/README.md`); fixes there come before this.
2. Rebase this branch on `main`, fix lint, and review the diff of every file shared with
   single-session mode.
3. Review the invariants with tests for: a stranger in the group, an anonymous admin, the wrong
   group, a tap in one topic carrying another session's id.
4. Write the missing documents, then open it for review.
