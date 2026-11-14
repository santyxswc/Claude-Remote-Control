# ADR 0011: Choices, skill taps and incoming files

- Status: Accepted
- Date: 2026-11-14

## Context

F7 adds buttons that answer Claude's questions (`ask_choice`) and buttons that request a skill
(`/skills`). F10 lets the owner send photos and files to the session. All three add new ways for
the phone to make text or data reach Claude. They must not create a path around the controls
that already exist: authentication, the rate limit, the brake, the permission relay and redaction.

## Decision

1. **A choice is text, never a verdict.** Choice buttons use their own prefix (`c1:`), next to
   `p1:` (permissions) and `k1:` (skills). Each prefix has an anchored, strict parser, and one
   `ButtonTapHandler` authenticates every tap before routing it. Only `p1:` reaches
   `ResolvePermission`. A chosen label goes to the session through `HandleInboundMessage`,
   directly from `AnswerChoice`, and not through the text chain. The text chain's
   `PermissionVerdictStep` would read a label such as "yes abcde" as a verdict.
2. **Choices belong to the polling process**, like permission requests (ADR 0007). Each choice
   is stored with its session, is answered only by that session's process, and is cancelled when
   another process takes the poller lock. `ask_choice` is refused while this process does not
   poll. Answers are stored with compare-and-set before delivery, and a failed delivery reopens
   the choice.
3. **A skill tap is typed text.** `RequestSkill` feeds `Use the skill /<name>` into the full
   inbound chain as a message from the owner. The tap path already authenticated the sender, and
   the chain applies the rate limit, the brake gate and the audit. The wording is an instruction,
   not a bare slash command. It is not documented whether a channel event runs a slash command,
   and a bare `/name` could collide with the bot's own commands (F7, "The wording").
4. **The inbox belongs to the session.** Files go to `<stateDir>/inbox/<session>/`. Only that
   process reads them, the session id names the directory, and other sessions' inboxes are
   deleted when the lock is taken, like orphan permission requests. Retention is 24 h and a
   200 MB quota.
5. **What a file may be is decided by the extension and the content together**, never by the
   MIME type Telegram reports or the name the sender gave. The stored name is ours: 16 random
   bytes in hex plus the allowlisted extension. The original name is only metadata. SVG is
   excluded because it is an active document.
6. **Downloads never block the chat.** `AttachmentStep` starts the download and returns; at most
   two run at a time and shutdown aborts them. The download URL contains the bot token, so it is
   confined to `TelegramAttachmentSource`, whose errors are replaced with redacted summaries.

## Consequences

- No new inbound path skips authentication. Taps use the tap path's checks, files and the typed
  "Other…" answer use the message chain, and skill taps use both. Nothing is downloaded or
  forwarded while braked.
- Choice and file events carry `kind` in their meta, so Claude can tell them from typed text.
  The MCP instructions say that files are untrusted content.
- Two sessions each see only their own choices and files. With two sessions open, `ask_choice`
  works only in the polling one (F14 changes the routing).
- An answer can reach Claude after later messages, because a download runs in the background
  while the chat continues.
- Plugin skills are not listed. Whether `/name` in a channel event runs directly, and how skills
  with `disable-model-invocation` behave from the chat, need live verification.
