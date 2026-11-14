# telegram-bridge

A Claude Code channel (an MCP server over stdio) that bridges a Telegram chat to a local Claude
Code session. The approved design is `docs/plan.md` (Spanish); each flow has its own brief in
`docs/flows/`, and decisions live in `docs/adr/`.

## Architecture rules

- Layers: `src/domain` -> `src/application` (`ports/`, `use-cases/`) -> `src/adapters/*` ->
  `src/main.ts`. Dependencies point inward only.
- `src/domain` imports nothing outside `src/domain`: no npm packages, no `node:` or `bun:` builtins.
- `src/application` imports only `src/domain`, `src/application` and `zod`.
- The application layer defines the ports; adapters implement them. Keep ports small.
- One use case per file, with a single reason to change.
- `src/main.ts` (the channel), `src/cli.ts` (the `telegram-bridge` CLI), `src/hook.ts` (the
  notice hook entrypoint) and `src/brakeHook.ts` (the `PreToolUse` brake) are the only composition
  roots and wire everything by hand (no DI container). Larger wiring lives in small factory modules
  under `src/composition/`, used only by those roots.
- Outbound text, prompts and images always go through `buildOutbound()` (`src/composition/outbound.ts`): redaction,
  then chunking (prompts with buttons: redaction, then fitting to one message; images: caption redaction and fitting). Never construct
  `TelegramChatGateway` anywhere else; a test enforces it.
- `bun run check:arch` enforces the import rules; do not weaken it to make code pass.

## Runtime rules

- In the channel process stdout belongs to the MCP stdio transport. Never `console.log` in
  `src/`; log through the `Logger` port (stderr). The CLI talks to the user only through the
  `Terminal` port.
- User-facing text (bot replies, CLI output) comes from `src/application/i18n/messages.ts`
  (Spanish default, English via `TELEGRAM_BRIDGE_LOCALE=en`). Diagnostic logs stay in English.
- Secrets (the bot token, pairing codes) never appear in logs, errors, audit rows or test
  snapshots. Log Telegram errors only through `describeTelegramError`; persist only hashes of
  codes; never accept a secret as a CLI argument. Tests assert this.
- Only one process polls Telegram, the holder of the poller lock (ADR 0006).
- `src/hook.ts` runs inside the user's Claude Code session on every matching event. It must stay
  fast (node builtins only; a test enforces it) and fail open: exit 0, nothing on stdout,
  diagnostics only with `TELEGRAM_BRIDGE_DEBUG=1` on stderr. Hook IPC is a Unix socket or a
  named pipe with an HMAC per frame (ADR 0008), never a network socket.
- `src/brakeHook.ts` runs synchronously before every tool call. Its no-brake path must stay one
  failed `open` of `<stateDir>/brake.json` (no stdin, no IPC, node builtins only). Missing flag:
  exit 0, nothing on stdout; flag present but unreadable: still braked (ADR 0003).
- `src/adapters/chart/chartWorker.ts` runs as its own child process (ADR 0014). It is the only
  module that imports Vega, Vega-Lite or resvg (lazily; a test enforces it); the channel never
  loads them. Its stdout is the one JSON result line.
- Windows is a first-class target: build paths with `node:path`, never hardcode `/` paths, `~`,
  Unix sockets (except behind `src/adapters/ipc/endpoint.ts`) or POSIX-only tools.
- The repository is also the plugin (ADR 0009): `.claude-plugin/plugin.json` keeps the version of
  `package.json`, and `hooks/hooks.json` lists exactly the events `src/hook.ts` handles plus the
  synchronous `PreToolUse` brake.
- The channel contract is a research preview. Keep everything contract-specific inside
  `src/adapters/mcp`, and check the official docs rather than memory before changing it.
- Stay on `@modelcontextprotocol/sdk` 1.x: Claude Code does not register a channel server that
  negotiates MCP protocol revision 2026-07-28 (see `docs/adr/0005-f0-findings.md`).

## Workflow

- Tests live in `tests/`, mirroring `src/`, and use test doubles for ports.
- A flow is not closed until its tests exist and `bun run check` passes.
- Commands:
  - `bun run check`: lint, typecheck, architecture check and tests (what CI runs)
  - `bun run format`: apply Biome formatting and safe fixes
  - `bun test`: tests only
  - `bun run bridge -- <command>`: the CLI (`init`, `pair`, `access list`, `access revoke <id>`,
    `stop [reason]`, `resume`)
