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
