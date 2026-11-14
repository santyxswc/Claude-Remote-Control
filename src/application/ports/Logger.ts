export type LogFields = Readonly<Record<string, unknown>>

/**
 * Diagnostic logging. Implementations must never write to stdout, which is
 * reserved for the MCP stdio transport.
 */
export interface Logger {
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}
