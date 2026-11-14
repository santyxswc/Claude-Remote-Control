import type { PermissionRequest, PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { Messages } from '../i18n/messages.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PromptGateway } from '../ports/PromptGateway.ts'
import { type DecisionCause, renderPermissionPrompt } from './renderPermissionPrompt.ts'

/**
 * Posts a request's prompt and keeps every copy in step with its state.
 * Failures are logged per copy and never thrown: the state is what counts,
 * and an unedited copy only shows stale buttons that the state machine
 * refuses anyway.
 */
export class PermissionPrompts {
  constructor(
    /** The redacting decorator from `buildOutbound`. */
    private readonly gateway: PromptGateway,
    private readonly messages: Messages,
    private readonly logger: Logger,
  ) {}

  /** Sends one copy per chat; returns where the delivered ones landed. */
  async send(request: PermissionRequest, chatIds: readonly string[]): Promise<PromptRef[]> {
    const { text, keyboard } = renderPermissionPrompt(request, this.messages)
    const refs: PromptRef[] = []
    for (const chatId of chatIds) {
      try {
        refs.push(await this.gateway.sendPrompt(chatId, text, keyboard))
      } catch (error) {
        this.logger.warn('could not send a permission prompt', {
          requestId: request.id,
          chatId,
          error,
        })
      }
    }
    return refs
  }

  /** Re-renders every copy for the current state (buttons removed once closed). */
  async refresh(
    request: PermissionRequest,
    actor?: SenderProfile,
    cause?: DecisionCause,
  ): Promise<void> {
    const { text, keyboard } = renderPermissionPrompt(request, this.messages, actor, cause)
    for (const ref of request.prompts) {
      try {
        await this.gateway.editPrompt(ref, text, keyboard)
      } catch (error) {
        this.logger.warn('could not update a permission prompt', {
          requestId: request.id,
          chatId: ref.chatId,
          error,
        })
      }
    }
  }
}
