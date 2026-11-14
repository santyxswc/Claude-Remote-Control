# ADR 0002: TypeScript on Bun

- Status: Accepted
- Date: 2026-11-13

## Context

A Claude Code channel is an MCP server spawned over stdio. The channels reference states that the
only hard requirement is the `@modelcontextprotocol/sdk` package and a Node.js-compatible runtime
(Bun, Node and Deno all work), and the official channel plugins run on Bun. The owner's PC runs
Windows, so the runtime must work there as well as on Linux and macOS.

## Decision

- Language: TypeScript with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
  and `verbatimModuleSyntax`.
- Runtime and test runner: Bun (`bun test`), pinned in CI.
- Libraries: `@modelcontextprotocol/sdk` (1.x, pinned exactly; see ADR 0005), `zod` for runtime
  validation, grammY for Telegram (from F1/F2).
- Tooling: Biome for lint and format, `tsc --noEmit` for type checking, GitHub Actions on Ubuntu
  and Windows.

## Consequences

- Same runtime and install path as the official plugins; Bun's built-in HTTP server and SQLite
  avoid extra dependencies.
- Bun-specific APIs (`Bun.serve`, `bun:sqlite`) may only be used in adapters, never in the
  domain or application layers, so the core stays portable to Node.
- Users must install Bun, as they already must for the official channel plugins.
