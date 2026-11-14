import type { HandleInboundMessage } from '../use-cases/HandleInboundMessage.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/** Step 7, the end of the chain: hands the text to the session. */
export class ForwardToSessionStep implements InboundStep {
  constructor(private readonly forward: HandleInboundMessage) {}

  async handle(message: InboundMessage, _next: InboundHandler): Promise<void> {
    const { sender, text } = message
    if (sender === undefined || text === undefined) return
    await this.forward.execute({ ...message, sender, text })
  }
}
