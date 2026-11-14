import type { CaptureTarget } from './CaptureTarget.ts'

/** Longer than any URL worth typing on a phone; keeps argv and captions small. */
export const MAX_CAPTURE_URL_LENGTH = 2048

export type CaptureUrlProblem = 'empty' | 'too_long' | 'unparseable' | 'scheme' | 'credentials'

export type CaptureUrlResult =
  | { readonly ok: true; readonly target: Extract<CaptureTarget, { kind: 'url' }> }
  | { readonly ok: false; readonly problem: CaptureUrlProblem }

/** `scheme:rest`, as RFC 3986 spells a scheme. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s
/** After `host:`, a port: digits, then the end or a path, query or fragment. */
const PORT_THEN_REST = /^\d{1,5}(?:[/?#]|$)/
/** Whitespace or control characters anywhere: never part of a URL typed for us. */
const SPACE_OR_CONTROL = /[\s\p{Cc}]/u

/**
 * The URL policy for page captures. Only `http:` and `https:`, without
 * credentials. A bare `localhost:3000` or `example.com/x` gets `http://`.
 * Loopback and LAN hosts are allowed on purpose: capturing the dev server is
 * the feature (see the threat model). The normalized URL always starts with
 * `http`, so it can never be read as a command-line flag.
 */
export function parseCaptureUrl(raw: string): CaptureUrlResult {
  const text = raw.trim()
  if (text === '') return { ok: false, problem: 'empty' }
  if (text.length > MAX_CAPTURE_URL_LENGTH) return { ok: false, problem: 'too_long' }
  if (SPACE_OR_CONTROL.test(text) || text.startsWith('-')) {
    return { ok: false, problem: 'unparseable' }
  }

  const scheme = SCHEME.exec(text)
  const hostAndPort = scheme !== null && PORT_THEN_REST.test(scheme[2] ?? '')
  const candidate = scheme === null || hostAndPort ? `http://${text}` : text

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, problem: 'unparseable' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, problem: 'scheme' }
  if (url.username !== '' || url.password !== '') return { ok: false, problem: 'credentials' }
  if (url.hostname === '') return { ok: false, problem: 'unparseable' }
  if (url.href.length > MAX_CAPTURE_URL_LENGTH) return { ok: false, problem: 'too_long' }
  return { ok: true, target: { kind: 'url', url: url.href, host: url.host } }
}
