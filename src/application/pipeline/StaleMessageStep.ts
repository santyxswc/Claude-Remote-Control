import type { AuditLog } from '../ports/AuditLog.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

export interface StaleMessageStepDeps {
  /** When this process started to receive messages, in epoch milliseconds. */
  readonly sessionStartedAt: number
  /** How much older than the session a message may be and still count as sent to it. */
  readonly graceMs: number
  readonly clock: Clock
  readonly chat: ChatGateway
  readonly audit: AuditLog
  readonly logger: Logger
  /** The notice for the sender, sent once per chat. */
  readonly notice: string
}

/**
 * Drops what the owner sent before this session existed. The chat platform
 * keeps messages nobody collected (Telegram: up to 24 hours) and hands them
 * over when polling starts; an instruction, a `/resume` or a file from
 * yesterday must not be acted on by a session started today.
 *
 * Runs right after authentication, so strangers learn nothing and a stale
 * message costs no rate-limit token. The sender is told once per chat; every
 * drop is audited with its age, never its text.
 */
export class StaleMessageStep implements InboundStep {
  readonly #notified = new Set<string>()

  constructor(private readonly deps: StaleMessageStepDeps) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    const { sessionStartedAt, graceMs } = this.deps
    if (message.sentAt >= sessionStartedAt - graceMs) {
      await next(message)
      return
    }

    const senderId = message.sender?.id ?? `chat:${message.chatId}`
    const ageSeconds = Math.round((sessionStartedAt - message.sentAt) / 1000)
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: `telegram:${senderId}`,
      event: 'message.stale_dropped',
      details: { senderId, messageId: message.messageId, ageSeconds },
    })
    this.deps.logger.info('dropped a message sent before this session started', {
      senderId,
      ageSeconds,
    })

    if (this.#notified.has(message.chatId)) return
    this.#notified.add(message.chatId)
    try {
      await this.deps.chat.sendText(message.chatId, this.deps.notice)
    } catch (error) {
      this.deps.logger.warn('could not send the stale-messages notice', { error })
    }
  }
}
