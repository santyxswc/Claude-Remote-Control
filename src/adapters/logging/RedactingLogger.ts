import type { LogFields, Logger } from '../../application/ports/Logger.ts'
import { serializeErrors } from './StderrLogger.ts'

export const REDACTED = '[redacted]'

/**
 * Decorator that removes known secrets (the bot token) from every message
 * and field before they reach the real logger. A safety net: callers should
 * already avoid logging secrets.
 */
export class RedactingLogger implements Logger {
  readonly #secrets: readonly string[]

  constructor(
    private readonly inner: Logger,
    secrets: readonly string[],
  ) {
    this.#secrets = secrets.filter((secret) => secret.length > 0)
  }

  info(message: string, fields?: LogFields): void {
    this.inner.info(this.#clean(message), this.#cleanFields(fields))
  }

  warn(message: string, fields?: LogFields): void {
    this.inner.warn(this.#clean(message), this.#cleanFields(fields))
  }

  error(message: string, fields?: LogFields): void {
    this.inner.error(this.#clean(message), this.#cleanFields(fields))
  }

  #clean(text: string): string {
    return this.#secrets.reduce((acc, secret) => acc.replaceAll(secret, REDACTED), text)
  }

  #cleanFields(fields: LogFields | undefined): LogFields | undefined {
    if (fields === undefined) return undefined
    const json = JSON.stringify(fields, serializeErrors)
    const cleaned = this.#clean(json)
    return cleaned === json ? fields : (JSON.parse(cleaned) as LogFields)
  }
}
