import type { StatusMessageDeps } from './PinStatusMessage.ts'

/** `/unpin` (F9): unpins this chat's status message and stops updating it. False if there was none. */
export class UnpinStatusMessage {
  constructor(private readonly deps: StatusMessageDeps) {}

  async execute(chatId: string): Promise<boolean> {
    const { board, gateway, store, logger } = this.deps
    const ref = store.find(chatId)
    if (ref === undefined) return false
    store.remove(chatId)
    board.policy.forget(chatId)
    board.recreated.delete(chatId)
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: `telegram:${chatId}`,
      event: 'status.unpinned',
      details: { chatId },
    })
    try {
      await gateway.unpinStatus(ref)
    } catch (error) {
      logger.info('could not unpin the status message', { error })
    }
    return true
  }
}
