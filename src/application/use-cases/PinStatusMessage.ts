import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { StatusMessageGateway } from '../ports/StatusMessageGateway.ts'
import type { StatusMessageStore } from '../ports/StatusMessageStore.ts'
import type { StatusBoard } from '../status/StatusBoard.ts'

export type PinOutcome = 'pinned' | 'not_pinned' | 'failed'

export interface StatusMessageDeps {
  readonly board: StatusBoard
  /** Must be the decorated gateway from `buildOutbound` (redacted, one message). */
  readonly gateway: StatusMessageGateway
  readonly store: StatusMessageStore
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
}

/**
 * `/pin` (F9): sends the status message to this chat (silently), pins it
 * and remembers it, so the updater edits it from now on, across restarts. A
 * previous status message of the chat is unpinned and forgotten first.
 * Commands run after authentication, so the chat is an allowlisted sender's.
 */
export class PinStatusMessage {
  constructor(private readonly deps: StatusMessageDeps) {}

  async execute(chatId: string): Promise<PinOutcome> {
    const { board, gateway, store, logger } = this.deps
    const previous = store.find(chatId)
    if (previous !== undefined) {
      store.remove(chatId)
      await gateway.unpinStatus(previous).catch((error: unknown) => {
        logger.info('could not unpin the previous status message', { error })
      })
    }
    board.policy.forget(chatId)
    board.recreated.delete(chatId)
    const text = board.render()
    const now = this.deps.clock.now()
    let ref: Awaited<ReturnType<StatusMessageGateway['sendStatus']>>
    try {
      ref = await gateway.sendStatus(chatId, text)
    } catch (error) {
      logger.warn('could not send the status message', { error })
      return 'failed'
    }
    store.put(ref, now)
    board.policy.sent(chatId, text, now)
    this.deps.audit.append({
      at: now,
      actor: `telegram:${chatId}`,
      event: 'status.pinned',
      details: { chatId },
    })
    try {
      await gateway.pinStatus(ref)
      return 'pinned'
    } catch (error) {
      logger.warn('could not pin the status message', { error })
      return 'not_pinned'
    }
  }
}
