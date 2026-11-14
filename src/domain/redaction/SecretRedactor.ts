/** What replaces each secret in outbound text. */
export const REDACTION_MARK = '[REDACTED]'

/** A half-open range `[start, end)` of UTF-16 code units holding a secret. */
export interface SecretSpan {
  readonly start: number
  readonly end: number
}

/** Strategy: one way of recognizing secrets in text. */
export interface SecretDetector {
  readonly name: string
  find(text: string): Iterable<SecretSpan>
}

export interface RedactionResult {
  readonly text: string
  /** How many separate secrets were replaced. Never log anything but this count. */
  readonly count: number
}

/**
 * Replaces everything any detector flags with `REDACTION_MARK`. Spans that
 * overlap (say, an `sk-ant-` key that the generic `sk-` rule also matches)
 * are merged first, so every secret is replaced exactly once and counted once.
 */
export class SecretRedactor {
  constructor(private readonly detectors: readonly SecretDetector[]) {}

  redact(text: string): RedactionResult {
    const spans = mergeOverlapping(this.detectors.flatMap((detector) => [...detector.find(text)]))
    if (spans.length === 0) return { text, count: 0 }
    let out = ''
    let cursor = 0
    for (const span of spans) {
      out += text.slice(cursor, span.start) + REDACTION_MARK
      cursor = span.end
    }
    return { text: out + text.slice(cursor), count: spans.length }
  }
}

function mergeOverlapping(spans: SecretSpan[]): SecretSpan[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const span of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && span.start < last.end) {
      last.end = Math.max(last.end, span.end)
    } else {
      merged.push({ start: span.start, end: span.end })
    }
  }
  return merged
}
