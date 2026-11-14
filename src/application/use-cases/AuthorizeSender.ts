import { isSenderId, type SenderId } from '../../domain/Sender.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'

/** Is this sender user id (never a chat id) on the allowlist? */
export class AuthorizeSender {
  constructor(private readonly allowed: AllowedSenderStore) {}

  execute(senderId: SenderId): boolean {
    return isSenderId(senderId) && this.allowed.has(senderId)
  }
}
