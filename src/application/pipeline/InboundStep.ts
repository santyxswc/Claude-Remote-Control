import type { InboundMessage } from './InboundMessage.ts'

export type InboundHandler = (message: InboundMessage) => Promise<void>

/**
 * One link of the inbound Chain of Responsibility. A step either handles the
 * message (and stops the chain by not calling `next`) or passes it on.
 */
export interface InboundStep {
  handle(message: InboundMessage, next: InboundHandler): Promise<void>
}

/** Chains steps in order. Whatever falls off the end is dropped. */
export function buildPipeline(steps: readonly InboundStep[]): InboundHandler {
  const end: InboundHandler = async () => {}
  return steps.reduceRight<InboundHandler>(
    (next, step) => (message) => step.handle(message, next),
    end,
  )
}
