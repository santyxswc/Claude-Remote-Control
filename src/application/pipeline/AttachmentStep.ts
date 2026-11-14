import type { ReceiveAttachment } from '../use-cases/ReceiveAttachment.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * After the brake gate (F10): a photo or file is handed to the download in
 * the background, so a slow download never holds up the chat (or `/stop`,
 * which has a lane of its own anyway). Everything else goes on.
 */
export class AttachmentStep implements InboundStep {
  constructor(private readonly receive: Pick<ReceiveAttachment, 'start'>) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    if (message.attachment === undefined || message.sender === undefined) {
      await next(message)
      return
    }
    this.receive.start({ ...message, sender: message.sender, attachment: message.attachment })
  }
}
