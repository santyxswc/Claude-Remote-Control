/**
 * Temp git repositories for tests (F8). Every git process gets an
 * environment without the user's or the system's configuration (an empty
 * global file, no system file, a temp HOME); setup commands run with hooks
 * and fsmonitor off. Nothing here touches a real repository or the network.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { join } from 'node:path'

export const GIT = Bun.which('git')

/** The environment for git in a test: `home` becomes HOME and holds an empty global config. */
export function isolatedGitEnv(home: string): Record<string, string> {
  mkdirSync(home, { recursive: true })
  const config = join(home, 'empty.gitconfig')
  writeFileSync(config, '')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('GIT_')) env[key] = value
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    // An empty file: Git for Windows cannot open `\\.\nul` as a config file.
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}

/** A setup command in `dir`, hooks and fsmonitor off. Throws on failure. */
export function setupGit(dir: string, env: Record<string, string>, ...args: string[]): string {
  const result = Bun.spawnSync(
    [
      GIT ?? 'git',
      '-c',
      `core.hooksPath=${devNull}`,
      '-c',
      'core.fsmonitor=false',
      '-C',
      dir,
      ...args,
    ],
    { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

/** A fresh repository on `main` with a local identity and no signing. */
export function initTestRepo(dir: string, env: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  setupGit(dir, env, 'init', '-q', '-b', 'main')
  setupGit(dir, env, 'config', 'user.name', 'Test')
  setupGit(dir, env, 'config', 'user.email', 'test@example.invalid')
  setupGit(dir, env, 'config', 'commit.gpgsign', 'false')
  setupGit(dir, env, 'config', 'core.autocrlf', 'false')
}

export function writeIn(dir: string, path: string, content: string | Uint8Array): void {
  const full = join(dir, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

export function commitAll(dir: string, env: Record<string, string>, message: string): void {
  setupGit(dir, env, 'add', '-A')
  setupGit(dir, env, 'commit', '-q', '-m', message)
}
