import type { PhotoSizeInfo } from '../../domain/attachments/attachmentPolicy.ts'
import type { SenderProfile } from '../../domain/Sender.ts'

export type ChatKind = 'private' | 'group' | 'supergroup' | 'channel'

/** A photo or a general file (F10). Every field is the platform's claim, untrusted. */
export type InboundAttachment =
  | { readonly kind: 'photo'; readonly sizes: readonly PhotoSizeInfo[] }
  | {
      readonly kind: 'document'
      readonly fileId: string
      readonly fileName: string | undefined
      readonly size: number | undefined
    }

/**
 * Why a message reaches the session, beyond "the owner typed it". Set by
 * steps and use cases of the core, never by platform adapters; it becomes
 * extra channel meta.
 */
export type ForwardContext =
  | { readonly kind: 'choice'; readonly choiceId: string }
  | { readonly kind: 'memory'; readonly proposalId: string }
  | {
      readonly kind: 'attachment'
      readonly path: string
      readonly name: string
      readonly mime: string
      readonly size: number
    }

/** A chat message as the core sees it, independent of the chat platform. */
export interface InboundMessage {
  readonly chatId: string
  /** The platform's id of this message within the chat, as a decimal string. */
  readonly messageId: string
  readonly chatKind: ChatKind
  /** Missing for messages without a user author (e.g. channel posts). */
  readonly sender: SenderProfile | undefined
  /** Undefined for anything that is not a text message (photos, stickers, voice...). */
  readonly text: string | undefined
  /** When the platform says it was sent, in epoch milliseconds. */
  readonly sentAt: number
  /** A photo or a file; other media leave it undefined (and `text` too). */
  readonly attachment?: InboundAttachment
  /** The caption of a photo or file. */
  readonly caption?: string
  /** Set when the message is part of an album (sent as separate messages). */
  readonly mediaGroupId?: string
  readonly forwardContext?: ForwardContext
}
