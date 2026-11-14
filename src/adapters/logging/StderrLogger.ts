import type { LogFields, Logger } from '../../application/ports/Logger.ts'

/** Anything with a `write(string)` method, such as `process.stderr`. */
export interface TextSink {
  write(chunk: string): unknown
}

type Level = 'info' | 'warn' | 'error'

/** Writes one line per entry to stderr (stdout belongs to the MCP transport). */
export class StderrLogger implements Logger {
  readonly #sink: TextSink

  constructor(sink: TextSink = process.stderr) {
    this.#sink = sink
  }

  info(message: string, fields?: LogFields): void {
    this.#write('info', message, fields)
  }

  warn(message: string, fields?: LogFields): void {
    this.#write('warn', message, fields)
  }

  error(message: string, fields?: LogFields): void {
    this.#write('error', message, fields)
  }

  #write(level: Level, message: string, fields: LogFields | undefined): void {
    const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields, serializeErrors)}`
    this.#sink.write(`telegram-bridge [${level}] ${message}${suffix}\n`)
  }
}

function serializeErrors(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value
}
