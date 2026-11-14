import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'
import { StatusFloodWaitError, StatusMessageGoneError } from '../ports/StatusMessageGateway.ts'
import type { StatusMessageDeps } from './PinStatusMessage.ts'

export interface UpdateStatusDeps extends StatusMessageDeps {
  readonly allowed: Pick<AllowedSenderStore, 'has'>
  /** Only the polling process edits (another one may be polling the same bot). */
  readonly canEdit: () => boolean
}

/**
 * Keeps the pinned status messages current (F9). `tick` runs on a timer of
 * its own, never in the inbound lanes, so a slow or flood-limited edit holds
 * nothing else up (M1): each tick renders once, the policy keeps only the
 * latest render per chat and decides whether an edit is due, and a 429 only
 * pushes the next edit back. A message that is gone is recreated and pinned
 * once; if that one goes too, the chat is dropped until the next `/pin`.
 */
export class UpdateStatusMessages {
  #ticking = false
  #finished = false

  constructor(private readonly deps: UpdateStatusDeps) {}

  async tick(): Promise<void> {
    if (this.#ticking || this.#finished || !this.deps.canEdit()) return
    this.#ticking = true
    try {
      const { board, store } = this.deps
      const refs = store.list()
      if (refs.length === 0) return
      const text = board.render()
      for (const ref of refs) {
        if (!this.deps.allowed.has(ref.chatId)) {
          this.#drop(ref.chatId)
          continue
        }
        const now = this.deps.clock.now()
        board.policy.observe(ref.chatId, text, now)
        const due = board.policy.due(ref.chatId, now)
        if (due !== undefined) await this.#edit(ref, due, now)
      }
    } finally {
      this.#ticking = false
    }
  }

  /**
   * The session ended: one last edit, "session ended", to every status
   * message, at once and best effort, while this process still polls.
   * Updates stop until `resume`.
   */
  async finish(): Promise<void> {
    if (this.#finished) return
    this.#finished = true
    // Another process polls now and owns the messages.
    if (!this.deps.canEdit()) return
    const { board, store, gateway, logger } = this.deps
    board.record({ kind: 'ended' })
    const text = board.render()
    await Promise.all(
      store.list().map((ref) =>
        gateway.editStatus(ref, text).catch((error: unknown) => {
          logger.info('could not mark the status message as ended', { error })
        }),
      ),
    )
  }

  /** Polling started (again) here: updates resume. */
  resume(): void {
    this.#finished = false
    this.deps.board.record({ kind: 'restarted' })
  }

  async #edit(ref: PromptRef, text: string, now: number): Promise<void> {
    const { board, gateway, logger } = this.deps
    try {
      await gateway.editStatus(ref, text)
      board.policy.sent(ref.chatId, text, now)
    } catch (error) {
      if (error instanceof StatusFloodWaitError) {
        board.policy.floodWait(ref.chatId, now + error.retryAfterMs)
        logger.info('status edits back off', { retryAfterMs: error.retryAfterMs })
      } else if (error instanceof StatusMessageGoneError) {
        await this.#recreate(ref.chatId, text, now)
      } else {
        board.policy.failed(ref.chatId, now)
        logger.warn('could not edit the status message', { error })
      }
    }
  }

  async #recreate(chatId: string, text: string, now: number): Promise<void> {
    const { board, gateway, store, logger } = this.deps
    if (board.recreated.has(chatId)) {
      logger.info('the status message is gone again; giving up until /pin', { chatId })
      this.#drop(chatId)
      return
    }
    board.recreated.add(chatId)
    try {
      const ref = await gateway.sendStatus(chatId, text)
      store.put(ref, now)
      board.policy.sent(chatId, text, now)
      await gateway.pinStatus(ref).catch((error: unknown) => {
        logger.info('could not pin the recreated status message', { error })
      })
    } catch (error) {
      logger.warn('could not recreate the status message; giving up until /pin', { error })
      this.#drop(chatId)
    }
  }

  #drop(chatId: string): void {
    this.deps.store.remove(chatId)
    this.deps.board.policy.forget(chatId)
  }
}
