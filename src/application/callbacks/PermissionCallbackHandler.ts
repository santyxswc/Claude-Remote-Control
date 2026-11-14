import { EventThrottle } from '../../domain/EventThrottle.ts'
import { DROPPED_LOG_WINDOW_MS } from '../../domain/inboundLimits.ts'
import { TokenBucket } from '../../domain/TokenBucket.ts'
import type { Messages } from '../i18n/messages.ts'
import { parsePermissionCallback } from '../permissions/callbackData.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PromptGateway } from '../ports/PromptGateway.ts'
import type { AuthorizeSender } from '../use-cases/AuthorizeSender.ts'
import type { ResolvePermission } from '../use-cases/ResolvePermission.ts'
import type { InboundCallback } from './InboundCallback.ts'

export interface PermissionCallbackHandlerDeps {
  readonly authorize: AuthorizeSender
  readonly resolve: ResolvePermission
  /** Only `answerCallback` is used here. */
  readonly prompts: Pick<PromptGateway, 'answerCallback'>
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
  readonly limiter?: TokenBucket
}

/**
 * The authenticated path for button taps, the twin of the message chain:
 * private chat only, sender allowlisted by user id, rate limited. A tap
 * that fails the first two is dropped without even answering it, like a
 * message from a stranger. Allowlisted taps are always answered so the
 * client's spinner stops; malformed button data is answered with nothing.
 */
export class PermissionCallbackHandler {
  readonly #limiter: TokenBucket
  readonly #dropLog = new EventThrottle(DROPPED_LOG_WINDOW_MS)

  constructor(private readonly deps: PermissionCallbackHandlerDeps) {
    this.#limiter = deps.limiter ?? new TokenBucket()
  }

  async handle(callback: InboundCallback): Promise<void> {
    const { sender } = callback
    const { logger } = this.deps
    const now = this.deps.clock.now()
    if (
      callback.chatKind !== 'private' ||
      sender === undefined ||
      callback.chatId !== sender.id ||
      !this.deps.authorize.execute(sender.id)
    ) {
      const senderId = sender?.id ?? null
      const decision = this.#dropLog.record(senderId ?? 'unknown', now)
      if (decision.emit)
        logger.info('dropped a button tap from an unauthorized sender', { senderId })
      return
    }

    if (!this.#limiter.take(sender.id, now).allowed) {
      await this.#answer(callback.id)
      return
    }
    const parsed = parsePermissionCallback(callback.data)
    if (parsed === undefined) {
      logger.warn('ignored a button tap with unknown data', { senderId: sender.id })
      await this.#answer(callback.id)
      return
    }

    let text: string | undefined
    try {
      const outcome = await this.deps.resolve.execute({ ...parsed, sender, via: 'button' })
      text = this.deps.messages.permissionFeedback(outcome)
    } catch (error) {
      logger.error('handling a permission tap failed', { requestId: parsed.requestId, error })
    }
    await this.#answer(callback.id, text)
  }

  async #answer(callbackId: string, text?: string): Promise<void> {
    try {
      await this.deps.prompts.answerCallback(callbackId, text)
    } catch (error) {
      this.deps.logger.warn('could not answer a button tap', { error })
    }
  }
}
