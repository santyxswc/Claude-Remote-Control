/**
 * Turns what whisper.cpp wrote into the text shown to the owner (F13). Pure.
 *
 * whisper.cpp's text output (`-otxt`) has one segment per line. Timestamps
 * are off (`-nt`), but a line that still starts with one is stripped anyway,
 * as are the `[BLANK_AUDIO]` markers it emits for silence. The segments are
 * joined with spaces; controls, bidi overrides and invisible characters go
 * (`sanitizeDisplayText`), whitespace collapses. Nothing is cut here: the
 * caller refuses a transcript that is too long rather than send part of it.
 */
import { sanitizeDisplayText } from '../displayText.ts'

/** `[00:00:00.000 --> 00:00:02.000]` or `[00:00.000 --> 00:02.000]`, at the start of a line. */
const TIMESTAMP =
  /^\s*\[\s*\d{1,2}(?::\d{2}){1,2}[.,]\d{1,3}\s*-->\s*\d{1,2}(?::\d{2}){1,2}[.,]\d{1,3}\s*\]/

/** whisper.cpp's marker for a segment without speech. */
const BLANK_AUDIO = /\[\s*BLANK_AUDIO\s*\]/gi

export function cleanTranscript(raw: string): string {
  const joined = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(TIMESTAMP, '').replace(BLANK_AUDIO, ' '))
    .join(' ')
  return sanitizeDisplayText(joined, Number.MAX_SAFE_INTEGER)
}

/** Code points, the unit of `MAX_TRANSCRIPT_LENGTH`. */
export function transcriptLength(text: string): number {
  return [...text].length
}
