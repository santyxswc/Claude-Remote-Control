/** What can be captured: the whole screen, or a web page by URL. */
export type CaptureKind = 'screen' | 'url'

export const CAPTURE_KINDS: readonly CaptureKind[] = ['screen', 'url']

/** A validated capture target; a `url` target always went through `parseCaptureUrl`. */
export type CaptureTarget =
  | { readonly kind: 'screen' }
  | {
      readonly kind: 'url'
      /** Normalized `http:`/`https:` URL, never starting with `-`. */
      readonly url: string
      /** `host[:port]` only: what the audit log may keep. */
      readonly host: string
    }
