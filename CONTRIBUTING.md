# Contributing

Thanks for helping. This project controls a local PC from a chat, so changes are reviewed with
security in mind first. Read [SECURITY.md](SECURITY.md) and [docs/threat-model.md](docs/threat-model.md)
before touching anything on the inbound or outbound path.

## Setup

You need [Bun](https://bun.sh) (CI pins 1.4.4).

```bash
git clone https://github.com/santyxswc/Claude-Remote-Control
cd Claude-Remote-Control
bun install
bun run check
```

`bun run check` runs, in order, lint (Biome), typecheck (`tsc --noEmit`), the architecture check
and `bun test`. It is what CI runs on Ubuntu and Windows. `bun run format` applies Biome formatting
and safe fixes. Everything must pass before a pull request is ready.

No Telegram token or Claude Code session is needed to run the tests.

## Architecture rules

The rules live in [CLAUDE.md](CLAUDE.md) and the layers are described in
[docs/architecture.md](docs/architecture.md). The ones that matter most:

- Dependencies point inward: `src/domain`, then `src/application` (ports and use cases), then
  `src/adapters/*`, then the composition roots. `bun run check:arch` enforces the import rules; do
  not weaken it to make code pass.
- One use case per file. Keep ports small.
- Outbound text, prompts and images go only through `buildOutbound()`. Never construct
  `TelegramChatGateway` elsewhere.
- Nothing writes to stdout in the channel process. Log through the `Logger` port.
- User-facing strings come from `src/application/i18n/messages.ts`, in Spanish and English.
- Secrets (token, pairing codes) never appear in logs, errors, audit rows or test snapshots.
- Windows is a first-class target: use `node:path`, no hardcoded `/` paths, no POSIX-only tools
  outside the adapters that guard them.
- Keep everything specific to the channel contract inside `src/adapters/mcp`, and check the
  official docs rather than memory before changing it.

## Workflow

- **Conventional Commits** for commit messages, for example `feat: screenshots on demand (F5)`,
  `fix: ...`, `docs: ...`, `test: ...`, `refactor: ...`.
- **One flow or one change per pull request.** Small and reviewable beats large.
- **Tests are required.** Tests live in `tests/`, mirroring `src/`. Use fakes for the ports
  (see `tests/fakes.ts`, `tests/fakeTelegram.ts`, `tests/application/harness.ts`). No network, no
  real waits: inject the `Clock`, `Sleeper` and `Every` ports and advance a fake clock. A new
  flow also gets an acceptance test in `tests/acceptance/`.
- Smoke tests that touch the real machine are skipped unless `TELEGRAM_BRIDGE_SMOKE=1` and never
  run in CI.
- A flow is not closed until its tests exist and `bun run check` passes.

## Extension points

**A chat command.** Implement `ChatCommand` (`src/application/commands/ChatCommand.ts`): a
`name` (`[a-z0-9_]{1,32}`), a localized `description` and `execute(context)`. Use a use case for
the work. Register it in `createCommandRegistry`
(`src/application/commands/createCommandRegistry.ts`) in the order you want it in `/help`. Add its
strings to both catalogs in `src/application/i18n/messages.ts`. Commands run after
authentication. Tests: `tests/application/commands/`.

**A screen or page capturer.** Implement the `ScreenCapturer` port
(`src/application/ports/ScreenCapturer.ts`) in `src/adapters/capture/` (run programs with an
argument array, no shell, a timeout, and an output path you generate). Add it in
`createScreenCapturers` (`src/adapters/capture/createScreenCapturers.ts`), including what to tell
the owner to install when it is missing. Tests: `tests/adapters/capture/`.

**A redaction detector.** Add a `PatternDetector` with a distinctive prefix or structure to
`KNOWN_SECRET_PATTERNS` in `src/domain/redaction/secretDetectors.ts`, or implement
`SecretDetector` (`src/domain/redaction/SecretRedactor.ts`). Include tests for matches and for
look-alikes that must pass through (`tests/domain/redaction/`).

**A hook event.** Add the name to `HOOK_EVENT_NAMES`
(`src/application/hooks/hookEventNames.ts`); forward its fields, clamped, in `projectHookPayload`
(`src/adapters/ipc/hookPayload.ts`); parse them in `src/application/hooks/hookEvents.ts`; handle
it in `HookEventRouter`. Register it in `hooks/hooks.json` and in the settings snippet in
`docs/flows/F4.md`. `src/hook.ts` must stay builtin-only and fail open;
`tests/plugin/manifest.test.ts` checks that the manifest and the handled events agree.

**An inbound step.** Implement `InboundStep` (`src/application/pipeline/InboundStep.ts`) and
place it in `createSessionSteps` or `createInboundPipeline` where the security order requires.

## Documentation to update

- The flow brief in `docs/flows/` when behaviour changes (objective, steps, acceptance, manual
  verification). If a flow doc and the code disagree, fix the doc.
- An ADR in `docs/adr/` for a decision that is hard to reverse or that deviates from the plan.
- `docs/threat-model.md` when a control is added or changes.
- `README.md` and `README.es.md` together (commands, configuration, requirements).
- `CLAUDE.md` when an architecture rule changes.
- `.claude-plugin/plugin.json` keeps the version of `package.json`; `hooks/hooks.json` lists
  exactly the events `src/hook.ts` handles plus the `PreToolUse` brake.

## Reporting security problems

Do not use public issues. See [SECURITY.md](SECURITY.md).
