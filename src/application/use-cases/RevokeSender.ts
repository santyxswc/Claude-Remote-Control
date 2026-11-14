import type { SenderId } from '../../domain/Sender.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'

export interface RevokeSenderDeps {
  readonly allowed: AllowedSenderStore
  readonly audit: AuditLog
  readonly clock: Clock
}

/** Removes a sender from the allowlist. Returns false when it was not there. */
export class RevokeSender {
  constructor(private readonly deps: RevokeSenderDeps) {}

  execute(senderId: SenderId): boolean {
    if (!this.deps.allowed.remove(senderId)) return false
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: 'terminal',
      event: 'sender.revoked',
      details: { senderId },
    })
    return true
  }
}
