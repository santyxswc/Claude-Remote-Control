import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const STATE_DIR_ENV = 'TELEGRAM_BRIDGE_HOME'
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'

/** Owner-only permissions. On Windows chmod only toggles read-only; the profile ACL protects it. */
export const PRIVATE_DIR_MODE = 0o700
export const SECRET_FILE_MODE = 0o600

/**
 * Where the bridge keeps its local state (token, allowlist, database).
 * `TELEGRAM_BRIDGE_HOME` wins when set to a non-empty value; otherwise
 * `<config>/channels/telegram-bridge`, where `<config>` is `CLAUDE_CONFIG_DIR`
 * or `<home>/.claude`. Pure: no filesystem access.
 */
export function resolveStateDir(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  const override = nonBlank(env[STATE_DIR_ENV])
  if (override !== undefined) return resolve(override)
  const configDir = nonBlank(env[CLAUDE_CONFIG_DIR_ENV])
  const base = configDir === undefined ? join(homeDir, '.claude') : resolve(configDir)
  return join(base, 'channels', 'telegram-bridge')
}

/** `resolveStateDir` bound to the current process. */
export function defaultStateDir(): string {
  return resolveStateDir(process.env, homedir())
}

/**
 * Creates the state directory if needed and restricts it to the owner.
 * On Windows the mode is not enforced: the directory relies on the
 * user-profile ACL, which is why it must live under the user's profile.
 */
export function ensureStateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  chmodSync(dir, PRIVATE_DIR_MODE)
  return dir
}

/** Writes a file readable only by the owner, atomically (temp file + rename). */
export function writeSecretFile(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, { mode: SECRET_FILE_MODE })
  chmodSync(temp, SECRET_FILE_MODE)
  renameSync(temp, path)
}

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}
