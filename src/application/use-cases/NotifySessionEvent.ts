import type {
  NoticeCandidate,
  NoticePolicy,
  Suppression,
} from '../../domain/notices/NoticePolicy.ts'
import { attentionTrigger, projectName } from '../../domain/notices/sessionNotices.ts'
import type { Messages } from '../i18n/messages.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'

/** A hook event worth telling the owner about. Every text is untrusted. */
export type SessionEvent =
  | {
      readonly event: 'Stop'
      readonly cwd: string | undefined
      readonly lastMessage: string | undefined
    }
  | {
      readonly event: 'Notification'
      readonly cwd: string | undefined
      readonly message: string | undefined
      readonly notificationType: string | undefined
    }

export type NoticeOutcome =
  | { readonly status: 'sent'; readonly delivered: number }
  | { readonly status: 'suppressed'; readonly reason: Suppression }
  /** Not a kind of notification that asks for the owner. */
  | { readonly status: 'ignored' }
  /** Nobody is paired: notices are off. */
  | { readonly status: 'no_recipients' }

export interface NotifySessionEventDeps {
  /** Must be the decorated gateway: redaction, then chunking. */
  readonly chat: ChatGateway
  readonly allowed: AllowedSenderStore
  readonly policy: NoticePolicy
  /** When this session last relayed a still-open permission prompt with buttons. */
  readonly lastPermissionRelayAt: () => number | undefined
  readonly messages: Pick<Messages, 'noticeFinished' | 'noticeAttention'>
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
}

/**
 * Tells every allowlisted sender that Claude finished (`Stop`) or waits for
 * them (`Notification`), subject to the debounce policy. The whole text goes
 * to the outbound pipeline, which redacts it and only then fits it to one
 * message (M3). Audit rows carry
 * the event and the length, never the text.
 */
export class NotifySessionEvent {
  constructor(private readonly deps: NotifySessionEventDeps) {}

  async execute(input: SessionEvent): Promise<NoticeOutcome> {
    const { messages, logger } = this.deps
    const project = projectName(input.cwd)
    let candidate: NoticeCandidate
    if (input.event === 'Stop') {
      const text = messages.noticeFinished({ project, message: fit(input.lastMessage) })
      candidate = { kind: 'finished', text }
    } else {
      const trigger = attentionTrigger(input.notificationType)
      if (trigger === undefined) return { status: 'ignored' }
      const text = messages.noticeAttention({ project, message: fit(input.message) })
      candidate = {
        kind: 'attention',
        text,
        trigger,
        permissionRelayedAt:
          trigger === 'permission' ? this.deps.lastPermissionRelayAt() : undefined,
      }
    }

    const recipients = this.deps.allowed.list().map((sender) => sender.id)
    if (recipients.length === 0) return { status: 'no_recipients' }

    const now = this.deps.clock.now()
    const reason = this.deps.policy.decide(candidate, now)
    if (reason !== undefined) {
      logger.info('notice suppressed', { event: input.event, reason })
      return { status: 'suppressed', reason }
    }

    let delivered = 0
    for (const chatId of recipients) {
      try {
        await this.deps.chat.sendText(chatId, candidate.text, { fitToOneMessage: true })
        delivered += 1
      } catch (error) {
        logger.warn('could not deliver a notice', { chatId, error })
      }
    }
    this.deps.audit.append({
      at: now,
      actor: 'session',
      event: 'notice.sent',
      details: {
        event: input.event,
        kind: candidate.kind,
        length: candidate.text.length,
        recipients: recipients.length,
        delivered,
      },
    })
    logger.info('sent a notice', { event: input.event, delivered })
    return { status: 'sent', delivered }
  }
}

function fit(text: string | undefined): string | undefined {
  return text?.trim()
}
