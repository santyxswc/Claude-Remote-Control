import type { Logger } from '../ports/Logger.ts'
import type { AuthorizeSender } from '../use-cases/AuthorizeSender.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * Step 3: authenticates by the sender's user id (never the chat id). Anything
 * from an unknown sender is dropped without a reply. The log line carries the
 * sender id only, never the message text.
 */
export class AuthenticateSenderStep implements InboundStep {
  constructor(
    private readonly authorize: AuthorizeSender,
    private readonly logger: Logger,
  ) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    const sender = message.sender
    if (sender === undefined || !this.authorize.execute(sender.id)) {
      this.logger.info('dropped message from an unauthorized sender', {
        senderId: sender?.id ?? null,
      })
      return
    }
    await next(message)
  }
}
