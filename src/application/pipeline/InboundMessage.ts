import type { SenderProfile } from '../../domain/Sender.ts'

export type ChatKind = 'private' | 'group' | 'supergroup' | 'channel'

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
}
