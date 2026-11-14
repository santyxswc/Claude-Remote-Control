/**
 * What an incoming file may be (F10). Pure: the use case feeds it the
 * declared metadata, the first bytes and the content as it streams.
 *
 * A file is kept only when its extension is on the allowlist AND its content
 * agrees: binary types must start with their magic bytes, text types must be
 * valid UTF-8 without NUL bytes and must not look like one of the binary
 * types. The stored name is ours (random id + the allowlisted extension);
 * the original name is display metadata only.
 */
import { sanitizeDisplayText } from '../displayText.ts'

/**
 * Bot API `getFile`: "bots can download files of up to 20MB in size". Read
 * as 10^6 bytes, like F5's limits, which errs on the low side.
 */
export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20_000_000
const MB = 1_000_000

export type SniffedType = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf'

/** Bytes of the head needed to sniff every binary type. */
export const SNIFF_BYTES = 12

export type AllowedType =
  | {
      readonly kind: 'binary'
      readonly extension: string
      readonly mime: string
      readonly magic: SniffedType
    }
  | { readonly kind: 'text'; readonly extension: string; readonly mime: string }

const BINARY: readonly [string, string, SniffedType][] = [
  ['png', 'image/png', 'png'],
  ['jpg', 'image/jpeg', 'jpeg'],
  ['jpeg', 'image/jpeg', 'jpeg'],
  ['gif', 'image/gif', 'gif'],
  ['webp', 'image/webp', 'webp'],
  ['pdf', 'application/pdf', 'pdf'],
]

/** Plain-text formats and common source code. Never shell scripts Windows runs on a double click. */
const TEXT: readonly [string, string][] = [
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['json', 'application/json'],
  ['csv', 'text/csv'],
  ['tsv', 'text/tab-separated-values'],
  ['log', 'text/plain'],
  ['yaml', 'application/yaml'],
  ['yml', 'application/yaml'],
  ['toml', 'application/toml'],
  ['xml', 'application/xml'],
  ['html', 'text/html'],
  ['htm', 'text/html'],
  ['css', 'text/css'],
  ['scss', 'text/plain'],
  ['js', 'text/javascript'],
  ['mjs', 'text/javascript'],
  ['cjs', 'text/javascript'],
  ['jsx', 'text/javascript'],
  ['ts', 'text/plain'],
  ['tsx', 'text/plain'],
  ['py', 'text/x-python'],
  ['rb', 'text/plain'],
  ['go', 'text/plain'],
  ['rs', 'text/plain'],
  ['java', 'text/plain'],
  ['kt', 'text/plain'],
  ['c', 'text/plain'],
  ['h', 'text/plain'],
  ['cpp', 'text/plain'],
  ['hpp', 'text/plain'],
  ['cs', 'text/plain'],
  ['swift', 'text/plain'],
  ['php', 'text/plain'],
  ['lua', 'text/plain'],
  ['sql', 'text/plain'],
  ['sh', 'text/plain'],
  ['vue', 'text/plain'],
  ['svelte', 'text/plain'],
  ['diff', 'text/x-diff'],
  ['patch', 'text/x-diff'],
]

export const ALLOWED_TYPES: ReadonlyMap<string, AllowedType> = new Map<string, AllowedType>([
  ...BINARY.map(([extension, mime, magic]): [string, AllowedType] => [
    extension,
    { kind: 'binary', extension, mime, magic },
  ]),
  ...TEXT.map(([extension, mime]): [string, AllowedType] => [
    extension,
    { kind: 'text', extension, mime },
  ]),
])

/** Every allowed extension, for the refusal message. */
export const ALLOWED_EXTENSIONS: readonly string[] = [...ALLOWED_TYPES.keys()]

/** Telegram re-encodes every photo as JPEG. */
export const PHOTO_TYPE = ALLOWED_TYPES.get('jpg') as AllowedType

export type AttachmentRefusal =
  /** Declared or streamed size over the limit. */
  | 'too_large'
  | 'empty'
  /** The extension is not on the allowlist (or there is none). */
  | 'type_not_allowed'
  /** The content is not what the extension says. */
  | 'type_mismatch'
  /** Per-sender budget spent. */
  | 'rate_limited'
  | 'download_failed'

/**
 * `TELEGRAM_BRIDGE_MAX_UPLOAD_MB`: whole megabytes, 1 to 20 (it can only
 * lower the Bot API limit). Unset: 20. Anything else: 20 and `invalid`.
 */
export function maxUploadBytes(raw: string | undefined): { bytes: number; invalid: boolean } {
  const value = raw?.trim() ?? ''
  if (value === '') return { bytes: TELEGRAM_DOWNLOAD_LIMIT_BYTES, invalid: false }
  const mb = /^[0-9]{1,2}$/.test(value) ? Number(value) : Number.NaN
  if (!(mb >= 1 && mb * MB <= TELEGRAM_DOWNLOAD_LIMIT_BYTES)) {
    return { bytes: TELEGRAM_DOWNLOAD_LIMIT_BYTES, invalid: true }
  }
  return { bytes: mb * MB, invalid: false }
}

/** The lowercase extension after the last dot, if it is a plain one (letters and digits). */
export function extensionOf(fileName: string | undefined): string | undefined {
  const match = /\.([A-Za-z0-9]{1,10})[\s.]*$/.exec(fileName ?? '')
  return match?.[1]?.toLowerCase()
}

/** The allowlisted type for a document's name, or why it is refused. */
export function typeForName(fileName: string | undefined): AllowedType | undefined {
  const extension = extensionOf(fileName)
  return extension === undefined ? undefined : ALLOWED_TYPES.get(extension)
}

/** Before downloading: Telegram's declared size, when it gives one. */
export function checkDeclaredSize(
  declared: number | undefined,
  maxBytes: number,
): AttachmentRefusal | undefined {
  if (declared === undefined) return undefined
  if (declared > maxBytes) return 'too_large'
  return declared === 0 ? 'empty' : undefined
}

const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0): boolean =>
  bytes.every((byte, i) => head[at + i] === byte)
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))

/** The binary type the first bytes announce, if any. */
export function sniff(head: Uint8Array): SniffedType | undefined {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return 'gif'
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'webp'
  if (startsWith(head, ascii('%PDF-'))) return 'pdf'
  return undefined
}

/** After the first bytes: a binary type must match its magic; a text type must not look binary. */
export function checkHead(type: AllowedType, head: Uint8Array): AttachmentRefusal | undefined {
  const sniffed = sniff(head)
  if (type.kind === 'binary') return sniffed === type.magic ? undefined : 'type_mismatch'
  return sniffed === undefined ? undefined : 'type_mismatch'
}

/**
 * Streaming check that a text file really is text: valid UTF-8 (a BOM is
 * fine) and no NUL byte. `push` returns false at the first bad chunk.
 */
export class TextContentCheck {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })
  #ok = true

  push(chunk: Uint8Array): boolean {
    if (!this.#ok) return false
    if (chunk.includes(0)) {
      this.#ok = false
      return false
    }
    try {
      this.#decoder.decode(chunk, { stream: true })
    } catch {
      this.#ok = false
    }
    return this.#ok
  }

  /** True when everything pushed was text, including a complete last character. */
  finish(): boolean {
    if (!this.#ok) return false
    try {
      this.#decoder.decode()
    } catch {
      this.#ok = false
    }
    return this.#ok
  }
}

export interface PhotoSizeInfo {
  readonly fileId: string
  readonly width: number
  readonly height: number
  readonly size: number | undefined
}

/** The largest size (by pixels) whose declared size fits; unknown sizes are capped while streaming. */
export function choosePhotoSize(
  sizes: readonly PhotoSizeInfo[],
  maxBytes: number,
): PhotoSizeInfo | undefined {
  return sizes
    .filter((size) => size.size === undefined || size.size <= maxBytes)
    .reduce<PhotoSizeInfo | undefined>(
      (best, size) =>
        best === undefined || size.width * size.height > best.width * best.height ? size : best,
      undefined,
    )
}

const MAX_NAME_LENGTH = 128

/**
 * The sender's file name as display metadata only (it never builds a path):
 * sanitized, path separators and characters Windows forbids replaced, at
 * most 128 code points, never empty.
 */
export function sanitizeAttachmentName(name: string | undefined): string {
  const clean = sanitizeDisplayText(name ?? '', MAX_NAME_LENGTH)
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/[\s.]+$/, '')
  return clean === '' || /^\.+$/.test(clean) ? 'file' : clean
}
