import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const STATE_DIR_ENV = 'TELEGRAM_BRIDGE_HOME'

/**
 * Where the bridge keeps its local state (token, allowlist, database).
 * `TELEGRAM_BRIDGE_HOME` wins when set to a non-empty value; otherwise
 * `<home>/.claude/channels/telegram-bridge`. Pure: no filesystem access.
 */
export function resolveStateDir(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  const override = env[STATE_DIR_ENV]
  if (override !== undefined && override.trim() !== '') {
    return resolve(override)
  }
  return join(homeDir, '.claude', 'channels', 'telegram-bridge')
}

/** `resolveStateDir` bound to the current process. */
export function defaultStateDir(): string {
  return resolveStateDir(process.env, homedir())
}
