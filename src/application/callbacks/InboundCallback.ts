import type { SenderProfile } from '../../domain/Sender.ts'
import type { ChatKind } from '../pipeline/InboundMessage.ts'

/** A tap on an inline button, as the core sees it. Every field is untrusted. */
export interface InboundCallback {
  /** The platform's id for answering this tap. */
  readonly id: string
  /** The chat of the message that carried the button; missing if the client did not say. */
  readonly chatId: string | undefined
  readonly chatKind: ChatKind | undefined
  /** The message that carried the button, as a decimal string; missing if the client did not say. */
  readonly messageId?: string
  readonly sender: SenderProfile | undefined
  readonly data: string | undefined
  /** The forum topic of the tapped message (F14), when the platform says it is in one. */
  readonly threadId?: string
}

export type CallbackHandler = (callback: InboundCallback) => Promise<void>
