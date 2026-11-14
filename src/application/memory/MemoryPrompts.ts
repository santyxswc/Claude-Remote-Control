import type { MemoryProposal } from '../../domain/memory/MemoryProposal.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import { PromptTooLongError } from '../errors.ts'
import type { MemoryStatusView, Messages } from '../i18n/messages.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PromptGateway, PromptKeyboard } from '../ports/PromptGateway.ts'
import { encodeMemoryCallback } from './memoryCallbackData.ts'

export function memoryKeyboard(proposal: MemoryProposal, messages: Messages): PromptKeyboard {
  if (!proposal.isPending) return []
  return [
    [
      { label: messages.memoryButtons.approve, data: encodeMemoryCallback(proposal.id, 'approve') },
      { label: messages.memoryButtons.reject, data: encodeMemoryCallback(proposal.id, 'reject') },
    ],
  ]
}

/**
 * Shows a memory proposal and keeps its message in step with its state. The
 * prompt must show exactly what Approve writes: it is sent with
 * `overflow: 'refuse'` and `redaction: 'refuse'`, so a proposal that would
 * be cut or have text replaced is never shown at all (the caller refuses it).
 */
export class MemoryPrompts {
  constructor(
    /** The redacting decorator from `buildOutbound`. */
    private readonly gateway: PromptGateway,
    private readonly messages: Messages,
    private readonly logger: Logger,
  ) {}

  /** Rejects with `PromptRedactedError` or `PromptTooLongError`, or when not delivered. */
  send(proposal: MemoryProposal): Promise<PromptRef> {
    return this.gateway.sendPrompt(
      proposal.chatId,
      this.messages.memoryPrompt(proposal.lines),
      memoryKeyboard(proposal, this.messages),
      { overflow: 'refuse', redaction: 'refuse' },
    )
  }

  /** Shows how it ended under the lines; removes the buttons unless it is pending again. */
  async refresh(
    proposal: MemoryProposal,
    status: MemoryStatusView,
    ref: PromptRef | undefined = proposal.prompt,
  ): Promise<void> {
    if (ref === undefined) return
    const keyboard = memoryKeyboard(proposal, this.messages)
    const line = this.messages.memoryStatus(status)
    try {
      try {
        await this.gateway.editPrompt(
          ref,
          `${this.messages.memoryPrompt(proposal.lines)}\n\n${line}`,
          keyboard,
          { overflow: 'refuse' },
        )
      } catch (error) {
        if (!(error instanceof PromptTooLongError)) throw error
        await this.gateway.editPrompt(ref, line, keyboard)
      }
    } catch (error) {
      this.logger.warn('could not update a memory proposal message', {
        proposalId: proposal.id,
        error,
      })
    }
  }
}
