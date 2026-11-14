import type { SenderProfile } from '../../domain/Sender.ts'

export type ChatKind = 'private' | 'group' | 'supergroup' | 'channel'

/** A chat message as the core sees it, independent of the chat platform. */
export interface InboundMessage {
  readonly chatId: string
  readonly chatKind: ChatKind
  /** Missing for messages without a user author (e.g. channel posts). */
  readonly sender: SenderProfile | undefined
  readonly text: string | undefined
  /** When the platform says it was sent, in epoch milliseconds. */
  readonly sentAt: number
}
