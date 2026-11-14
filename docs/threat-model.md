# Threat model

Whoever controls the bot controls the PC, so security is part of the MVP. The design assumes the
chat with the bot is not secret: messages are encrypted in transit to Telegram, but Telegram can
read them, and bot chats have no end-to-end encryption.

This is the threat table from `docs/plan.md` ("Seguridad"), kept up to date. Status is
**Implemented** (with the code that does it) or **Planned** (with the flow that will).

## Threats and controls

| Threat | Control | Status |
| --- | --- | --- |
| A stranger writes to the bot | Allowlist by the sender's user id (`from.id`), never the chat id. Everything else is dropped silently. Private chats only in the MVP | **Implemented (F1).** Inbound chain in `src/application/pipeline/`: `PrivateChatOnlyStep`, `PairingClaimStep` (the only thing an unknown sender can trigger; only a successful claim gets a reply), `AuthenticateSenderStep` (by `sender.id`). Acceptance: `tests/acceptance/F1.test.ts` |
| Pairing code intercepted or guessed | 128-bit code from the OS CSPRNG, valid 120 s and once; only its SHA-256 is stored; constant-time comparison; 5 failed attempts cancel the pairing; access only after the owner confirms the claimant's name, @username and id at the terminal | **Implemented (F1).** `src/domain/Pairing.ts`, `src/domain/pairingCode.ts`, `src/adapters/system/CryptoRandomSource.ts`, `src/adapters/system/Sha256SecretHasher.ts`, `src/application/use-cases/ClaimPairing.ts`, `ConfirmPairing.ts`, `src/adapters/cli/pairCommand.ts` |
| The bot token leaks | Token in a 0600 file outside the repository and out of logs. With it someone can impersonate the bot, but not forge messages from your id. Revoke it in BotFather | **Implemented (F1).** `<stateDir>/.env` written by `src/adapters/storage/DotEnvTokenStore.ts` via `writeSecretFile` (0600, state dir 0700; on Windows the user-profile ACL protects it, chmod is a no-op). Never accepted as a CLI argument (`src/adapters/cli/runCli.ts`); read without echo (`ConsoleTerminal.askSecret`). Telegram errors are reduced to redacted summaries (`src/adapters/telegram/redact.ts`) and the channel and CLI loggers are wrapped in `RedactingLogger`. A malformed token is rejected before any request (`botToken.ts`) |
| Your Telegram account is hijacked | Telegram two-step verification required by the guide; optional TOTP for high-risk actions; lock after inactivity | **Planned** (guide: publication phase; TOTP and inactivity lock: after F3) |
| A secret leaves through the chat | Redaction in the outbound pipeline: tokens with known prefixes, `.env` values, private keys | **Planned (F2).** In F1 the only outbound message is the fixed pairing acknowledgement, and the `reply` tool is not wired to Telegram yet |
| Approving something destructive by mistake | `RiskPolicy` detects patterns such as `rm -rf`, `git push --force` or `DROP` and asks for a second tap | **Planned (F3)** |
| Stale or double-tapped button | Each button carries the `request_id` from Claude Code; the state machine refuses to resolve twice; the keyboard is removed on resolution | **Planned (F3)** |
| Misleading text in a permission preview | `description` and `input_preview` are shown as escaped plain text, without formatting or links | **Planned (F3).** F1 already sends plain text only (no parse mode) in `TelegramChatGateway` |
| Another local process writes to the hooks socket | Socket with mode 0600 inside the user's directory | **Planned (F4)** |
| No record of what was approved | Append-only audit: who, when, what and which verdict | **Implemented for F1 events.** `audit_log` table with triggers that reject `UPDATE` and `DELETE` (`src/adapters/storage/sqlite.ts`); no update or delete API (`SqliteAuditLog`). Every pairing and allowlist change is audited, without codes, tokens or message text. Permission verdicts: **Planned (F3)** |

## Additional F1 notes

- **Two pollers.** Telegram serves one `getUpdates` consumer per bot. The channel and the `pair`
  CLI coordinate through a heartbeated lock row (ADR 0006), so the CLI never competes with a
  running session.
- **Concurrent writers.** The channel and the CLI share `bridge.sqlite` (WAL, busy timeout).
  Pairing transitions are compare-and-set on a revision number, so a claim and a replacement
  racing in two processes cannot both win.
- **Confirmation is fail-safe.** The pairing is marked confirmed before the sender is added; a
  crash in between leaves access denied.

## Known limits and open risks

- **Pairing denial of service.** Anyone who knows the bot's username can send five wrong
  `/start` codes during the 120 s window and cancel the pairing. They cannot gain access; the
  owner runs `pair` again.
- **Log volume.** Every dropped message from a stranger writes one stderr line (sender id only).
  A flood produces many lines; there is no rate limit yet (planned with the inbound rate-limit
  step).
- **Windows permissions.** File modes are not enforced on Windows; the state directory must be
  under the user's profile, whose ACL is the protection. The code does not touch ACLs.
- **Token in the environment.** `TELEGRAM_BOT_TOKEN` overrides the file. Environment variables
  are visible to other processes of the same user on some systems; the file is the recommended
  storage.
