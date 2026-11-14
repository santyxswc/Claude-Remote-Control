import type { CallbackHandler } from '../callbacks/InboundCallback.ts'
import type { InboundHandler } from '../pipeline/InboundStep.ts'

/** Why polling ended. Only `stopped` is a normal exit. */
export type PollingExit = 'stopped' | 'unauthorized' | 'conflict'

/** Pulls inbound messages from the chat platform and feeds them to a handler. */
export interface InboundPoller {
  /**
   * Resolves when polling ends, either through `stop` or a fatal error.
   * Button taps go to `onCallback`; without it they are dropped.
   */
  start(handler: InboundHandler, onCallback?: CallbackHandler): Promise<PollingExit>
  stop(): Promise<void>
}
