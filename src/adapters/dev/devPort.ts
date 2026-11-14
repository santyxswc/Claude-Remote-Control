import type { Logger } from '../../application/ports/Logger.ts'

export const DEV_PORT_ENV = 'TELEGRAM_BRIDGE_DEV_PORT'

/**
 * Parses `TELEGRAM_BRIDGE_DEV_PORT`. Unset or blank means the dev listener is
 * disabled (`undefined`). `0` asks the OS for a free port. Anything that is
 * not an integer in 0..65535 throws, so a typo never silently disables it.
 */
export function parseDevPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  const value = raw.trim()
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    throw new Error(`${DEV_PORT_ENV} must be an integer between 0 and 65535, got "${raw}"`)
  }
  return Number(value)
}

export interface DevListenerPortInput {
  /** `TELEGRAM_BRIDGE_DEV_PORT` as found in the environment. */
  readonly raw: string | undefined
  /** A bot token is configured, so Telegram is the way in. */
  readonly botConfigured: boolean
  readonly logger: Logger
}

/**
 * The port for the dev listener, or undefined when it must not start. A
 * malformed value is logged rather than thrown, so a typo never takes the
 * channel down. With a bot configured the listener never starts: it would be
 * a second, weaker way to type into the session.
 */
export function devListenerPort(input: DevListenerPortInput): number | undefined {
  let port: number | undefined
  try {
    port = parseDevPort(input.raw)
  } catch (error) {
    input.logger.error('invalid dev port; the dev listener is off', { error })
    return undefined
  }
  if (port !== undefined && input.botConfigured) {
    input.logger.error(
      `${DEV_PORT_ENV} is ignored because a bot token is configured; the dev listener is only for setups without telegram`,
    )
    return undefined
  }
  return port
}
