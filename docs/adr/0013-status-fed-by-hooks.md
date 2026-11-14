# ADR 0013: A pinned status fed by hooks, on its own lane

- Status: Accepted
- Date: 2026-11-14

## Context

F9 keeps one pinned message per chat that shows what the session is doing. Two questions decide
the design.

- **Where does the content come from?** Claude could write it, through a tool, but then the
  status shows what Claude says, not what happened, and a confused or steered Claude could show
  anything.
- **How often may it change?** Telegram limits bots to about one message per second per chat
  and answers floods with 429 and `retry_after`. The existing gateways wait out a 429, which is
  fine for a reply and wrong for a status that can always be sent later.

## Decision

1. **Hooks and the bridge's own state only.** The view is built from:
   - `UserPromptSubmit`, `PostToolUse`, attention `Notification`s and `Stop`, already routed
     for F4 (no new hook events, and `hooks.json` is unchanged);
   - the brake flag;
   - the counts of open permission requests and choices.

   Of a tool call it shows the tool name and, for shell tools, the hook's `description`, or a
   file's base name; never the command, a pattern, a URL or content. The hook projection now
   forwards only an allowlist of `tool_input` fields.
2. **The todo list is left out.** The task tools are not on by default on current models, so
   their hook events do not fire there. No event says what is in progress, and the subjects are
   model-written text (F9, "The todo list").
3. **A pure update policy** (`StatusUpdatePolicy`, fake-clock tests):
   - a 2 s trailing debounce, with a 10 s maximum wait;
   - one edit per chat per 5 s;
   - a global budget (10, then one per 3 s);
   - an unchanged render is never sent;
   - only the latest render per chat is kept;
   - a 429 backs off every chat until `retry_after`.
4. **Its own lane.**
   - The updater runs on a 1 s timer, outside the inbound lanes.
   - Its gateway makes one attempt per call and never sleeps: a 429 is an error the policy turns
     into a back-off.
   - Only the polling process edits.

   A flood wait therefore delays nothing else, `/stop` included (M1).
5. **Persisted, self-healing, quiet.**
   - The message id lives in SQLite (migration 4), so a restart edits the same message.
   - A deleted message is recreated and pinned once, then given up until `/pin`.
   - Sends and pins are silent.
   - On shutdown while polling, one bounded "session ended" edit is made.

## Alternatives considered

- **A `set_status` MCP tool for Claude.** It could show richer text, but it is Claude's word and
  costs a tool call each time. Rejected for the status itself; a future flow can add Claude's
  own notes elsewhere.
- **A second async `PreToolUse` hook for "running now".** It would show the tool before it
  finishes, but it adds a hook on every call beside the brake. `PostToolUse` was enough.
- **Edit on every event, retrying 429s like other sends.** It is simpler, but floods the chat
  and blocks behind `retry_after`. Rejected.

## Consequences

- The state can lag by the debounce (2 s) plus the tick (1 s), more under a flood wait.
- `PostToolUse` fires only on success, so a failing tool does not update "Last tool".
- Without hooks installed, the state stays "unknown"; the brake and pending counts still show.
- The pinned message is activity metadata (project, tool names, file base names, command
  descriptions) in a chat Telegram can read (threat model).
- Needs live verification: no notification for the silent send, pin and edits, and the 429 rate
  for edits in practice.
