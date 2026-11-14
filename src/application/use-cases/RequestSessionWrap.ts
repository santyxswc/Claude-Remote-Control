import type { SenderProfile } from '../../domain/Sender.ts'
import type { Messages } from '../i18n/messages.ts'
import type { InboundHandler } from '../pipeline/InboundStep.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { Clock } from '../ports/Clock.ts'

export type WrapOutcome = 'sent' | 'braked'

/**
 * `/wrap` (F12): one fixed instruction from the catalog is fed into the
 * inbound chain as text from the owner, exactly like typing it (rate limit,
 * brake gate, audit), the same as a `/diff` button. It asks Claude to call
 * `save_session_summary` and, if anything is worth keeping, `propose_memory`.
 * Nothing from the chat or the repository goes into it.
 */
export class RequestSessionWrap {
  constructor(
    private readonly deps: {
      /** The inbound chain. */
      readonly deliver: InboundHandler
      readonly brake: Pick<BrakeFlag, 'status'>
      readonly messages: Pick<Messages, 'wrapInstruction'>
      readonly audit: AuditLog
      readonly clock: Clock
    },
  ) {}

  async execute(input: {
    readonly chatId: string
    readonly sender: SenderProfile
  }): Promise<WrapOutcome> {
    // Checked here for the answer; the chain's brake gate would refuse the instruction anyway.
    if (this.deps.brake.status().engaged) return 'braked'
    const now = this.deps.clock.now()
    this.deps.audit.append({
      at: now,
      actor: `telegram:${input.sender.id}`,
      event: 'wrap.requested',
      details: { chatId: input.chatId },
    })
    await this.deps.deliver({
      chatId: input.chatId,
      messageId: '0',
      chatKind: 'private',
      sender: input.sender,
      text: this.deps.messages.wrapInstruction,
      sentAt: now,
    })
    return 'sent'
  }
}
