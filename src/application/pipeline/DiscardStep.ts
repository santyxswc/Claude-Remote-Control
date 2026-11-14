import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * Step 4, a placeholder: authenticated messages stop here until F2 replaces
 * this step with delivery to the session.
 */
export class DiscardStep implements InboundStep {
  async handle(_message: InboundMessage, _next: InboundHandler): Promise<void> {}
}
