import type { AllowedSender } from '../../domain/AllowedSender.ts'
import type { SenderId } from '../../domain/Sender.ts'

export interface AllowedSenderStore {
  /** Adds the sender, or refreshes its profile if it is already allowed. */
  add(sender: AllowedSender): void
  /** Returns false when the id was not allowed. */
  remove(id: SenderId): boolean
  has(id: SenderId): boolean
  list(): readonly AllowedSender[]
}
