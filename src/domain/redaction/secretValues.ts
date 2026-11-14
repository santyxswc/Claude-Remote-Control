import { SecretRedactor } from './SecretRedactor.ts'
import { ExactValueDetector, KNOWN_SECRET_PATTERNS } from './secretDetectors.ts'

/** Shorter values would match too much ordinary text. */
export const MIN_SECRET_VALUE_LENGTH = 8

const TRIVIAL: readonly RegExp[] = [
  /^[+-]?\d+(?:[.,]\d+)*$/, // numbers, ports, versions written as numbers
  /^(?:true|false|yes|no|on|off|null|none|undefined)$/i,
  /^[a-z]+(?:[-_.][a-z]+)*$/, // lowercase words: production, my-app, info.debug
  /^[A-Z][a-z]+$/, // a capitalized word
  /^[A-Z]+(?:_[A-Z]+)*$/, // CONSTANT_NAMES
  /^[^\s@:/]+@[^\s@:/]+\.[A-Za-z]{2,}$/, // e-mail addresses
  /^(?:\/|\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/])/, // absolute or relative paths
]

/** `scheme://host/...` without `user:password@`: an endpoint, not a credential. */
const URL_WITHOUT_CREDENTIALS = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s@]*$/

/**
 * Keeps the values worth redacting verbatim: long enough and not obviously
 * harmless. A value such as `NODE_ENV=production` must not turn every
 * "production" in Claude's replies into `[REDACTED]`.
 */
export function selectSecretValues(values: readonly string[]): string[] {
  const kept = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    if (value.length < MIN_SECRET_VALUE_LENGTH) continue
    if (URL_WITHOUT_CREDENTIALS.test(value)) continue
    if (TRIVIAL.some((pattern) => pattern.test(value))) continue
    kept.add(value)
  }
  return [...kept]
}

/** The outbound redactor: every known credential shape plus these literal values. */
export function createSecretRedactor(literalSecrets: readonly string[]): SecretRedactor {
  return new SecretRedactor([
    ...KNOWN_SECRET_PATTERNS,
    new ExactValueDetector(selectSecretValues(literalSecrets)),
  ])
}
