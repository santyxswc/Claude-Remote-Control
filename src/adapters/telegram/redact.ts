import { GrammyError, HttpError } from 'grammy'

export const REDACTED = '[redacted]'

/** Anything shaped like a Bot API token (`<bot id>:<secret>`), e.g. inside a request URL. */
const TOKEN_SHAPE = /\d{5,}:[A-Za-z0-9_-]{30,}/g

/** Removes the token, and anything that looks like one, from a string. */
export function redactToken(text: string, token: string | undefined): string {
  const withoutToken = token === undefined || token === '' ? text : text.replaceAll(token, REDACTED)
  return withoutToken.replace(TOKEN_SHAPE, REDACTED)
}

/** A log-safe summary of a Telegram call failure. */
export interface TelegramErrorSummary {
  readonly name: string
  readonly message: string
  /** Bot API error code (e.g. 401, 409) when Telegram answered. */
  readonly code?: number
}

/**
 * Summarizes an error without the token. grammY's `HttpError` wraps the raw
 * fetch error, whose message or fields can contain the request URL, and the
 * URL contains the token; only our redacted summary is ever logged.
 */
export function describeTelegramError(
  error: unknown,
  token: string | undefined,
): TelegramErrorSummary {
  if (error instanceof GrammyError) {
    return {
      name: 'GrammyError',
      code: error.error_code,
      message: redactToken(error.description, token),
    }
  }
  if (error instanceof HttpError) {
    return { name: 'HttpError', message: redactToken(error.message, token) }
  }
  if (error instanceof Error) {
    return { name: error.name, message: redactToken(error.message, token) }
  }
  return { name: 'UnknownError', message: redactToken(String(error), token) }
}

/** Telegram answers 401 for a revoked token and 404 for a malformed one. */
export function isTokenRejection(error: unknown): boolean {
  return error instanceof GrammyError && (error.error_code === 401 || error.error_code === 404)
}

/** Error thrown by our Telegram adapters instead of grammY's, so callers never see the URL. */
export class TelegramCallError extends Error {
  constructor(readonly summary: TelegramErrorSummary) {
    super(summary.code === undefined ? summary.message : `${summary.code}: ${summary.message}`)
    this.name = 'TelegramCallError'
  }
}
