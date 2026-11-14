import type { ImageSize } from './pngSize.ts'

/**
 * Bot API 10.4, `sendPhoto`: "The photo must be at most 10 MB in size. The
 * photo's width and height must not exceed 10000 in total. Width and height
 * ratio must be at most 20." `sendDocument`: "files of any type of up to
 * 50 MB in size". MB is read as 10^6 bytes, the stricter reading.
 */
export const PHOTO_MAX_BYTES = 10_000_000
export const PHOTO_MAX_DIMENSION_SUM = 10_000
export const PHOTO_MAX_ASPECT_RATIO = 20
export const DOCUMENT_MAX_BYTES = 50_000_000

export type ImageDelivery = 'photo' | 'document' | 'too_large' | 'empty'

/**
 * How an image goes out: as a photo when Telegram accepts it as one, else as
 * a document (which keeps every pixel), never silently dropped. Without known
 * dimensions it is a document, since the photo limits cannot be checked.
 */
export function chooseImageDelivery(bytes: number, size: ImageSize | undefined): ImageDelivery {
  if (bytes <= 0) return 'empty'
  if (bytes > DOCUMENT_MAX_BYTES) return 'too_large'
  if (size === undefined || bytes > PHOTO_MAX_BYTES) return 'document'
  const { width, height } = size
  const ratio = Math.max(width, height) / Math.min(width, height)
  if (width + height > PHOTO_MAX_DIMENSION_SUM || ratio > PHOTO_MAX_ASPECT_RATIO) return 'document'
  return 'photo'
}
