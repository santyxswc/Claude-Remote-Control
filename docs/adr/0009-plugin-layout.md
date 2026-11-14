# ADR 0009: One repository is both the dev checkout and the installable plugin

- Status: Accepted
- Date: 2026-11-14
- Sources (re-fetched 2026-11-14): plugin manifest reference
  (<https://code.claude.com/docs/en/plugins/manifest-reference.md>), hooks reference
  (<https://code.claude.com/docs/en/hooks>), and the reference plugin
  `external_plugins/telegram` in `anthropics/claude-plugins-official` (`.mcp.json`,
  `package.json`, `.claude-plugin/plugin.json`).

## Context

F4's hooks only help if they install together with the server. The plan wants "un solo repo
empaquetado como plugin". The repository-root `.mcp.json` already serves development: opened as
a project, Claude Code starts `bun ./src/main.ts` in the checkout. A plugin is installed into a
versioned cache directory (`${CLAUDE_PLUGIN_ROOT}`), and nothing in the docs says
`node_modules` is installed for it.

Facts from the docs that drive the choice:

- "Claude Code loads `.mcp.json` at the plugin root first, then each declared shape in order. A
  server name declared later replaces an earlier one" (`mcpServers` in `plugin.json`).
- `hooks/hooks.json` needs the top-level `"hooks"` wrapper. Exec form (`command` + `args`) avoids
  shell quoting and works on Windows when `command` is a real executable (`bun.exe` is).
- `${CLAUDE_PLUGIN_ROOT}` is substituted in hook `command`/`args` and in MCP `command`/`args`/`env`.
- `async: true` runs a command hook in the background; its `timeout` is not enforced then.
- The reference plugin starts its server with
  `bun run --cwd ${CLAUDE_PLUGIN_ROOT} --shell=bun --silent start`, where `start` is
  `bun install --no-summary 1>&2 && bun server.ts`.

## Decision

- **Server**: `.claude-plugin/plugin.json` declares `mcpServers.telegram-bridge` with
  `bun run --cwd ${CLAUDE_PLUGIN_ROOT} --shell=bun --silent start:plugin`. Installed as a plugin, it
  replaces the root `.mcp.json` entry of the same name. Opened as a project, only `.mcp.json` is
  read and development stays `bun ./src/main.ts`. No `${VAR:-default}` trick on
  `CLAUDE_PLUGIN_ROOT` is needed, and the docs do not say that syntax applies to plugin variables.
- **Dependencies**: `start:plugin` is
  `bun install --production --frozen-lockfile --no-summary 1>&2 && bun src/main.ts`. Its parts:
  - `--production` skips TypeScript and Biome.
  - `--frozen-lockfile` installs exactly `bun.lock`.
  - `1>&2` keeps install output off the MCP stdout, and `--shell=bun` makes that redirection work
    on Windows too.

  Measured on the dev box (Bun's global cache warm, so no download): about 8.1 s the first time,
  about 0.25 s once `node_modules` exists. The whole command wrote 0 bytes to stdout. A cold cache
  adds the download of about 28 MB. `node_modules` lands in the plugin root, which Claude Code
  replaces on update, so the first start after each update pays the install again.
  `${CLAUDE_PLUGIN_DATA}` would survive updates. We do not use it: Bun resolves `node_modules` from
  the script's directory, so that would need `NODE_PATH`-style tricks, and the docs do not name
  it for this.
- **Hooks**: `hooks/hooks.json` registers `Stop`, `Notification`, `UserPromptSubmit` and
  `PostToolUse` without matchers, as `bun ${CLAUDE_PLUGIN_ROOT}/src/hook.ts <Event>`, with
  `async: true` and `timeout: 5`. They are async because nothing is gained by blocking: none of
  these hooks returns a decision, and the entrypoint has its own 1.5 s deadline. The hook imports
  only node builtins, so it works before `bun install` ever ran. The fail-closed brake
  (`PreToolUse`, F6) will not be async.
- **Hook command form**: `bun src/hook.ts <Event>`, not `telegram-bridge hook <Event>` through
  `src/cli.ts`. The CLI root statically imports grammY and SQLite adapters, which would cost tens
  of milliseconds on every tool call.
- `tests/plugin/manifest.test.ts` keeps the version equal to `package.json`. It also checks that
  every hook event is one the entrypoint handles, that every referenced file exists, and that the
  hook script only imports builtins. `claude plugin validate .` (Claude Code 2.1.325) reports
  "Validation passed with warnings": no `author`, and `CLAUDE.md` at the plugin root is not loaded
  as context. Its directory-submission checks also flag a short README, no LICENSE (still an open
  decision in the plan) and no icon.

## Consequences

- One checkout serves both uses; a user who also opens this repository as a project with the
  plugin enabled gets two servers (`telegram-bridge` and the plugin-scoped one). Only one of them
  polls (ADR 0006).
- The first plugin start (and the first after each update) takes seconds longer while `bun
  install` runs; Claude Code waits for the MCP handshake meanwhile.
- **Needs live verification**:
  - that the `plugin.json` server really replaces the root `.mcp.json` entry;
  - that `${VAR:-}` in the server `env` behaves for plugin servers as it does in `.mcp.json`;
  - the plugin-scoped tool name for the reply permission (F3 doc);
  - `--channels plugin:telegram-bridge@<marketplace>`;
  - that async hooks fire as documented on Windows.
