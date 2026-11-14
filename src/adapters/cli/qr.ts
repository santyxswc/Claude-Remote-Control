import { renderUnicodeCompact } from 'uqr'

/**
 * A scannable QR code drawn with half-block characters. `uqr` was chosen
 * because it has no dependencies, ships its own types and renders straight
 * to a terminal string.
 */
export function renderQr(text: string): string {
  return renderUnicodeCompact(text, { border: 2 })
}
