import type { Logger } from '../ports/Logger.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/** Step 1: only one-to-one chats are served in the MVP; anything else is dropped silently. */
export class PrivateChatOnlyStep implements InboundStep {
  constructor(private readonly logger: Logger) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    if (message.chatKind !== 'private') {
      this.logger.info('dropped message from a non-private chat', { chatKind: message.chatKind })
      return
    }
    await next(message)
  }
}
