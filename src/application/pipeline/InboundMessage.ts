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

/** A voice note (F13). Every field is the platform's claim, untrusted. */
export interface InboundVoice {
  readonly fileId: string
  /** Seconds, "as defined by the sender". */
  readonly duration: number | undefined
  readonly size: number | undefined
}

/**
 * Why a message reaches the session, beyond "the owner typed it". Set by
 * steps and use cases of the core, never by platform adapters; it becomes
 * extra channel meta.
 */
export type ForwardContext =
  | {
      readonly kind: 'choice'
      readonly choiceId: string
      /** Set when the typed answer was a confirmed voice transcript (F13). */
      readonly transcriptId?: string
    }
  | { readonly kind: 'memory'; readonly proposalId: string }
  /** A voice transcript the owner confirmed with Send (F13). */
  | { readonly kind: 'voice'; readonly transcriptId: string }
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
  /** A voice note (F13); `text` is undefined. */
  readonly voice?: InboundVoice
  readonly forwardContext?: ForwardContext
  /**
   * Group chats only (F14), set by the platform adapter and read only by the
   * hub. The forum topic, only when the platform says the message belongs to
   * a topic (Telegram: `is_topic_message`).
   */
  readonly threadId?: string
  /** Sent on behalf of a chat (an anonymous admin, a linked channel): never a person. */
  readonly onBehalfOfChat?: true
  /** The chat is a forum supergroup (topics enabled). */
  readonly isForum?: true
  /** The group's title, sanitized; for the hub binding confirmation. */
  readonly chatTitle?: string
}
