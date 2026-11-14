# ADR 0001: Each user runs their own bot, with no shared relay

- Status: Accepted
- Date: 2026-11-13

## Context

The bridge lets a Telegram chat drive a Claude Code session on the user's PC. Whoever controls
the bot can send prompts and approve tool use on that PC. Two distribution models were
considered (see `docs/plan.md`, "Decisión de distribución"):

- every user creates their own bot with BotFather and everything runs locally;
- one shared bot plus a relay server operated by the project author.

Chats with bots have no end-to-end encryption, so a relay cannot be "blind": its operator would
read every user's code, paths and outputs, and a compromise of the relay would give an attacker
remote control of every connected PC.

## Decision

Each user creates and owns their own bot. The channel process on the user's PC polls Telegram
directly; there is no server operated by the project. Onboarding friction (about three minutes in
BotFather) is reduced by an `init` assistant that validates the token.

Pairing between the Telegram account and the PC still uses a one-time code, generated locally
with a cryptographic RNG (never by the model) and confirmed at the terminal.

## Consequences

- No infrastructure, cost or custody of other people's data; no central point to compromise.
- Telegram still sees the messages; this is documented as a limit, with a future
  `privacy: minimal` mode.
- Setup takes a few minutes longer than joining a shared bot.
- A shared bot stays possible as just another adapter, but only after its own threat model.
