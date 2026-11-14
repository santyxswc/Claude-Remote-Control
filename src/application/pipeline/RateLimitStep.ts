import type { TokenBucket } from '../../domain/TokenBucket.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

export interface RateLimitStepDeps {
  readonly limiter: TokenBucket
  readonly clock: Clock
  readonly chat: ChatGateway
  readonly audit: AuditLog
  readonly logger: Logger
  readonly slowDown: string
}

/**
 * Step 4: a per-sender token bucket (runs after authentication, so only
 * allowlisted ids are tracked). Over the limit the message is dropped; once
 * per notice window the sender is told to slow down, and that is audited.
 */
export class RateLimitStep implements InboundStep {
  constructor(private readonly deps: RateLimitStepDeps) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    const senderId = message.sender?.id ?? `chat:${message.chatId}`
    const now = this.deps.clock.now()
    const decision = this.deps.limiter.take(senderId, now)
    if (decision.allowed) {
      await next(message)
      return
    }
    if (!decision.notify) return

    this.deps.audit.append({
      at: now,
      actor: `telegram:${senderId}`,
      event: 'message.rate_limited',
      details: { senderId },
    })
    this.deps.logger.warn('rate limit hit; dropping messages', { senderId })
    try {
      await this.deps.chat.sendText(message.chatId, this.deps.slowDown)
    } catch (error) {
      this.deps.logger.warn('could not send the slow-down notice', { error })
    }
  }
}
