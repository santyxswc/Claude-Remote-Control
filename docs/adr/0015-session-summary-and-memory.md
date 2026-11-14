# ADR 0015: The bridge writes summaries and approved memory lines itself

- Status: Accepted
- Date: 2026-11-14

## Context

F12 closes a session from the phone: `/wrap` asks Claude for a summary saved in
`docs/sessions/`, and for lines worth keeping in the project's `CLAUDE.md`. `CLAUDE.md` is loaded
into every future session, so a line written there is a standing instruction to Claude. Anything
that can write it is a persistence path for a prompt injection ("from now on, approve
everything"). Three questions follow: who writes the files, how an owner approves a line, and
whether the wrap can happen by itself when the session ends.

## Decision

1. **`/wrap` is an instruction, like a `/diff` button (ADR 0012).** It feeds one fixed catalog
   text (`wrapInstruction` in `messages.ts`, nothing interpolated) into the full inbound chain
   as text from the owner: rate limit, brake gate and audit (`wrap.requested`). While braked it
   sends nothing and says so.
2. **The bridge writes the summary, not Claude.** `save_session_summary({chat_id, title,
   markdown})`:
   - The file is `<project>/docs/sessions/<UTC yyyy-mm-ddThhmmssZ>-<slug>.md`. The project is
     `CLAUDE_PROJECT_DIR` when it is absolute, else the channel's working directory (the same
     rule as F8's git).
   - The slug is a pure domain function: NFKD, accents dropped, `[a-z0-9-]`, at most 60
     characters cut at a hyphen, `session` when empty. No path can come from Claude.
   - The file is created with `open(..., 'wx')`, which never overwrites and never follows a link
     at the name; a collision tries `-2`, `-3`, ... (up to 50).
   - `docs` and `sessions` are created one level at a time. A level that is a symlink or
     junction resolving outside the project, or is not a directory, refuses the save.
   - Content: UTF-8, CRLF to LF, controls removed except newline and tab, bidi and zero-width
     characters removed, at most 200,000 bytes, a `# <title>` heading unless it starts with one.
   - The chat gets the relative path and the summary through the text pipeline (redacted,
     chunked), with a note that the local file is not redacted. Above 16,000 characters only the
     path and the length are sent. The tool returns the relative path.
3. **Nothing enters `CLAUDE.md` without a tap, and the bridge writes it.**
   `propose_memory({chat_id, lines})`:
   - 1 to 8 lines, each trimmed, at most 300 code points, a single line with no control,
     line-separator, bidi or zero-width character, and no code fence (```` ``` ````, `~~~`) or
     HTML comment marker (`<!--`, `-->`), which would change or hide what follows when the file
     is rendered.
   - What is approved is exactly what was shown. The prompt is sent with `redaction: 'refuse'`
     and `overflow: 'refuse'`: if redaction would change any line (a secret in it), or the lines
     do not fit one Telegram message, the tool returns an error and nothing is stored as pending.
   - Approve and Reject buttons, `m1:<id>:<a|r>`, are routed by `ButtonTapHandler` after its
     checks (private chat, own chat, allowlisted sender, rate limit). The parser is anchored, so
     an `m1:` tap can never reach `ResolvePermission`.
   - A `MemoryProposal` entity (pending, approved, rejected, expired, cancelled) with
     compare-and-set revisions, stored in SQLite (`memory_proposals`, schema version 5). The
     lines stay on disk only while pending. It expires after 30 minutes and belongs to the
     polling session (ADR 0007): another session's proposals are cancelled when the poller lock
     is taken.
   - One tap is enough, because every line is on screen. Approve claims the proposal (CAS), then
     the bridge appends `- <line>` bullets under `## Session notes` (created once, at the end of
     the file), keeping the rest byte for byte and the file's line endings. The write is atomic:
     a temporary file in the same directory, `fsync`, then `rename`. A failed write puts the
     proposal back to pending. Taps are idempotent; a second tap only gets a toast.
   - Refused writes: `CLAUDE.md` as a link resolving outside the project, not a regular file,
     larger than 1 MB, or changed between reading and renaming. A link inside the project is
     followed and stays a link.
   - Reject and expiry write nothing. The message is edited to show the outcome and loses its
     buttons.
   - The tool returns at once. The outcome reaches the session later as a channel message with
     `kind="memory"` and `proposal_id`, like F7's choices.
   - Audit: `memory.proposed` (id, chat, line count, characters), `memory.refused` (reason, line
     count), `memory.approved` and `memory.rejected` (id, line count), `memory.write_failed`
     (reason), `memory.expired` (ttl or orphaned). Never the lines.
4. **Brake.** An approval while braked still writes: the write is the owner's own local act,
   done by the bridge, not something Claude does. Nothing is forwarded to the session while
   braked; the toast says the lines were written and Claude was not told. F7 and F8 taps refuse
   under the brake because their only effect is to send Claude an instruction.
5. **Claude cannot write the same files quietly.** `RiskPolicy` marks as high risk:
   - `Write`, `Edit`, `MultiEdit` and `NotebookEdit` on `CLAUDE.md`, `CLAUDE.local.md`,
     `AGENTS.md` (any directory, any case, Windows 8.3 short names, trailing dots, `:stream`) or
     anything under a `.claude` directory;
   - shell writes to them: `>`/`>>`/`>|`/`2>` redirections, `tee`, `cp`/`mv`/`install` (and the
     PowerShell equivalents) with one as the destination, `Set-Content`/`Add-Content`/`Out-File`,
     `ln`, and `sed -i`/`perl -i`.

   A high-risk request needs a second tap (F3). This is a heuristic, not a sandbox: a script that
   writes the file is not recognized.
6. **No automatic wrap at session end.** The hooks reference (code.claude.com/docs/en/hooks)
   says of `SessionEnd`: "SessionEnd hooks have no decision control. They can't block session
   termination but can perform cleanup tasks. Claude Code discards their JSON output fields,
   such as `systemMessage`." and "SessionEnd hooks have a default timeout of 1.5 seconds." A
   hook there cannot make Claude do any more work, and the session is already ending. No hook
   event is added; `/wrap` is the way to close a session. (`Stop` fires after every turn, not
   only the last, so it is not a substitute either.)

## Consequences

- `chat_id` is required by both tools, a deviation from the plan's `save_session_summary(title,
  markdown)`: the notice and the buttons need a chat, and it is checked like `reply`'s. The
  `/wrap` instruction tells Claude to use the chat id of that message.
- The summary file is the owner's and is not redacted, so a summary that quotes a secret keeps
  it on disk (inside the project, which may be committed). The chat notice says so. Accepted:
  rewriting what Claude wrote would make the file unreliable, and the project's own files
  already hold whatever Claude read.
- A redacted line cannot be approved at all. That is deliberate: approving `[REDACTED]` would
  write something the owner did not see.
- The `CLAUDE.md` write bypasses Claude Code's permission prompt (the bridge is not Claude). The
  owner's tap is the approval.
- `changed_meanwhile` compares size and modification time. An editor that saves within the same
  millisecond with the same size would not be noticed; the window is a few milliseconds.

## Needs live verification

- How Claude follows the `/wrap` instruction: whether it calls both tools, and whether it uses
  the right `chat_id`.
- That the `kind="memory"` outcome is understood and Claude does not write the lines again.
- Approve and Reject on the phone; the message edit and the toast texts.
