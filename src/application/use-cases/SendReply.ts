import { EmptyMessageError, PartialDeliveryError } from '../errors.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { AuthorizeSender } from './AuthorizeSender.ts'

export interface ReplyRequest {
  readonly chatId: string
  readonly text: string
  /** A message id in that chat to thread the reply under. */
  readonly replyTo?: string
}

export type RefusalReason = 'chat_not_allowed' | 'empty_text' | 'invalid_reply_to'

export type ReplyOutcome =
  | { readonly status: 'sent'; readonly parts: number; readonly redactions: number }
  | { readonly status: 'refused'; readonly reason: RefusalReason }
  | {
      readonly status: 'failed'
      readonly delivered: number
      readonly total: number | undefined
      readonly error: string
    }

export interface SendReplyDeps {
  /** Must be the decorated gateway: redaction, then chunking. */
  readonly chat: ChatGateway
  readonly authorize: AuthorizeSender
  /** Non-platform chats that may be answered, such as the dev listener's `dev`. */
  readonly extraChatIds: ReadonlySet<string>
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
}

const MESSAGE_ID = /^[1-9][0-9]{0,15}$/
const PLAUSIBLE_CHAT_ID = /^-?[0-9]{1,20}$/

/**
 * Claude's `reply` tool. Claude must not be steerable into messaging
 * arbitrary chats, so the target must be the private chat of a sender who is
 * allowlisted right now (in a private chat the chat id is the user id);
 * revoking a sender stops replies at once. Audit rows carry ids and counts,
 * never the text.
 */
export class SendReply {
  constructor(private readonly deps: SendReplyDeps) {}

  async execute(request: ReplyRequest): Promise<ReplyOutcome> {
    const { chatId } = request
    const reason = this.#refusal(request)
    if (reason !== undefined) {
      this.#audit('reply.refused', { chatId: auditableChatId(chatId), reason })
      this.deps.logger.warn('reply refused', { reason })
      return { status: 'refused', reason }
    }

    try {
      const receipt = await this.deps.chat.sendText(
        chatId,
        request.text,
        request.replyTo === undefined ? undefined : { replyTo: request.replyTo },
      )
      this.#audit('reply.sent', { chatId, parts: receipt.parts, redactions: receipt.redactions })
      return { status: 'sent', parts: receipt.parts, redactions: receipt.redactions }
    } catch (error) {
      if (error instanceof EmptyMessageError) {
        this.#audit('reply.refused', { chatId, reason: 'empty_text' })
        return { status: 'refused', reason: 'empty_text' }
      }
      const partial = error instanceof PartialDeliveryError ? error : undefined
      const delivered = partial?.delivered ?? 0
      const total = partial?.total
      this.#audit('reply.failed', { chatId, delivered, total: total ?? null })
      this.deps.logger.error('reply failed', { chatId, delivered, total, error })
      return {
        status: 'failed',
        delivered,
        total,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  #refusal(request: ReplyRequest): RefusalReason | undefined {
    const allowed =
      this.deps.extraChatIds.has(request.chatId) || this.deps.authorize.execute(request.chatId)
    if (!allowed) return 'chat_not_allowed'
    if (request.text.trim() === '') return 'empty_text'
    if (request.replyTo !== undefined && !MESSAGE_ID.test(request.replyTo)) {
      return 'invalid_reply_to'
    }
    return undefined
  }

  #audit(
    event: 'reply.sent' | 'reply.refused' | 'reply.failed',
    details: Record<string, string | number | null>,
  ): void {
    this.deps.audit.append({ at: this.deps.clock.now(), actor: 'session', event, details })
  }
}

/** Whatever Claude passed is untrusted: keep it only if it looks like an id. */
function auditableChatId(chatId: string): string {
  return PLAUSIBLE_CHAT_ID.test(chatId) ? chatId : 'invalid'
}
