import { appendFileSync, chmodSync, closeSync, openSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { TextSink } from './StderrLogger.ts'

export const LOG_FILE_ENV = 'TELEGRAM_BRIDGE_LOG_FILE'

const PRIVATE_FILE_MODE = 0o600

export type LogFileChoice =
  | { readonly kind: 'off' }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'invalid'; readonly reason: 'relative' }

/**
 * Parses `TELEGRAM_BRIDGE_LOG_FILE`. Unset or blank: no file. A relative path
 * is refused, never resolved against the working directory (the channel's cwd
 * is whatever Claude Code was started in).
 */
export function parseLogFile(raw: string | undefined): LogFileChoice {
  if (raw === undefined || raw.trim() === '') return { kind: 'off' }
  const path = raw.trim()
  return isAbsolute(path) ? { kind: 'file', path } : { kind: 'invalid', reason: 'relative' }
}

/**
 * Writes every chunk to `primary` and appends it to an owner-only file.
 *
 * Claude Code keeps a channel's stderr only up to the moment the MCP
 * connection is established (seen on 2.1.325): later lines appear in no log,
 * with or without `--debug`. The file is the way to read them.
 *
 * The file is a diagnostic aid and must never break the channel: the first
 * failed write turns it off and says so once on `primary`.
 */
export class FileTeeSink implements TextSink {
  readonly #primary: TextSink
  readonly #path: string
  #broken = false

  constructor(primary: TextSink, path: string) {
    this.#primary = primary
    this.#path = path
    try {
      // Created owner-only; an existing file is tightened too (a no-op on Windows).
      closeSync(openSync(path, 'a', PRIVATE_FILE_MODE))
      chmodSync(path, PRIVATE_FILE_MODE)
    } catch (error) {
      this.#giveUp(error)
    }
  }

  write(chunk: string): unknown {
    const result = this.#primary.write(chunk)
    if (!this.#broken) {
      try {
        appendFileSync(this.#path, chunk)
      } catch (error) {
        this.#giveUp(error)
      }
    }
    return result
  }

  #giveUp(error: unknown): void {
    this.#broken = true
    const reason = error instanceof Error ? error.message : 'unknown error'
    this.#primary.write(`telegram-bridge [warn] log file disabled: ${reason}\n`)
  }
}
