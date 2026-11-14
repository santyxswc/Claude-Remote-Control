import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BotTokenStore } from '../../application/ports/BotTokenStore.ts'
import { writeSecretFile } from './stateDir.ts'

export const TOKEN_ENV = 'TELEGRAM_BOT_TOKEN'
export const TOKEN_FILE = '.env'

const TOKEN_LINE = /^\s*TELEGRAM_BOT_TOKEN\s*=(.*)$/

/**
 * The bot token in `<stateDir>/.env` (mode 0600) as `TELEGRAM_BOT_TOKEN=...`.
 * A non-blank `TELEGRAM_BOT_TOKEN` environment variable takes precedence.
 * Other lines in the file are preserved on save.
 */
export class DotEnvTokenStore implements BotTokenStore {
  readonly #path: string

  constructor(
    stateDir: string,
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {
    this.#path = join(stateDir, TOKEN_FILE)
  }

  /** True when the environment variable, not the file, provides the token. */
  get overriddenByEnv(): boolean {
    return nonBlank(this.env[TOKEN_ENV]) !== undefined
  }

  load(): string | undefined {
    const fromEnv = nonBlank(this.env[TOKEN_ENV])
    if (fromEnv !== undefined) return fromEnv
    for (const line of this.#lines()) {
      const match = TOKEN_LINE.exec(line)
      if (match !== null) return nonBlank(unquote(match[1] ?? ''))
    }
    return undefined
  }

  save(token: string): void {
    const kept = this.#lines().filter((line) => !TOKEN_LINE.test(line) && line.trim() !== '')
    writeSecretFile(this.#path, [...kept, `${TOKEN_ENV}=${token}`, ''].join('\n'))
  }

  #lines(): string[] {
    if (!existsSync(this.#path)) return []
    return readFileSync(this.#path, 'utf8').split(/\r?\n/)
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  return quoted?.[2] ?? trimmed
}
