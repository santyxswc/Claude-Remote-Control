import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const STATE_DIR_ENV = 'TELEGRAM_BRIDGE_HOME'
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'

/** Owner-only permissions. On Windows chmod only toggles read-only; the profile ACL protects it. */
export const PRIVATE_DIR_MODE = 0o700
export const SECRET_FILE_MODE = 0o600

type Env = Readonly<Record<string, string | undefined>>

/**
 * A state directory variable that would depend on the working directory.
 * The channel, the CLI and the hooks run in different directories, so such a
 * value would split them across different state (and the brake would not
 * reach the session). The message names the variable; the value is a path,
 * not a secret, but it is not needed to fix it.
 */
export class InvalidStateDirError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} must be an absolute path (or start with ~)`)
    this.name = 'InvalidStateDirError'
  }
}

/**
 * Where the bridge keeps its local state (token, allowlist, database).
 * `TELEGRAM_BRIDGE_HOME` wins when set to a non-empty value; otherwise
 * `<config>/channels/telegram-bridge`, where `<config>` is `CLAUDE_CONFIG_DIR`
 * or `<home>/.claude`. Pure: no filesystem access.
 *
 * Both variables must be absolute paths, or start with `~` / `~/` (the home
 * directory, as a shell would expand it). Anything else is relative to the
 * working directory, which differs between the channel, the CLI and the
 * hooks, so it throws `InvalidStateDirError` instead of being resolved.
 */
export function resolveStateDir(env: Env, homeDir: string): string {
  const override = stateDirVariable(env, STATE_DIR_ENV, homeDir)
  if (override !== undefined) return override
  const configDir = stateDirVariable(env, CLAUDE_CONFIG_DIR_ENV, homeDir)
  return join(configDir ?? join(homeDir, '.claude'), 'channels', 'telegram-bridge')
}

/**
 * For the PreToolUse brake only: like `resolveStateDir`, but an invalid
 * variable is skipped instead of throwing. The CLI and the channel refuse
 * an invalid value, so nobody engages a brake under it; skipping it means
 * the hook checks where a `stop` run without that variable (another shell,
 * the default setup) writes the flag. Failing open on every tool call
 * because of a typo would silently disable the brake.
 */
export function resolveStateDirIgnoringInvalid(env: Env, homeDir: string): string {
  const valid = (name: string) => {
    try {
      return stateDirVariable(env, name, homeDir)
    } catch {
      return undefined
    }
  }
  const override = valid(STATE_DIR_ENV)
  if (override !== undefined) return override
  return join(
    valid(CLAUDE_CONFIG_DIR_ENV) ?? join(homeDir, '.claude'),
    'channels',
    'telegram-bridge',
  )
}

/** `resolveStateDir` bound to the current process. Throws `InvalidStateDirError`. */
export function defaultStateDir(): string {
  return resolveStateDir(process.env, homedir())
}

function stateDirVariable(env: Env, name: string, homeDir: string): string | undefined {
  const raw = nonBlank(env[name])?.trim()
  if (raw === undefined) return undefined
  if (raw === '~') return homeDir
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homeDir, raw.slice(2))
  if (!isFullyQualified(raw)) throw new InvalidStateDirError(name)
  return resolve(raw)
}

/**
 * Absolute on POSIX. On Windows also a drive letter or a UNC share: `\dir`
 * and `C:dir` are relative to the current drive or its working directory.
 */
function isFullyQualified(path: string): boolean {
  if (process.platform === 'win32') return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path)
  return isAbsolute(path)
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
