import type { InboundHandler } from '../pipeline/InboundStep.ts'

/** Why polling ended. Only `stopped` is a normal exit. */
export type PollingExit = 'stopped' | 'unauthorized' | 'conflict'

/** Pulls inbound messages from the chat platform and feeds them to a handler. */
export interface InboundPoller {
  /** Resolves when polling ends, either through `stop` or a fatal error. */
  start(handler: InboundHandler): Promise<PollingExit>
  stop(): Promise<void>
}
