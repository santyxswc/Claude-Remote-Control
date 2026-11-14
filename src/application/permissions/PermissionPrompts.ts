import type { PermissionRequest, PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import { PromptTooLongError } from '../errors.ts'
import type { Messages } from '../i18n/messages.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PromptGateway } from '../ports/PromptGateway.ts'
import { type DecisionCause, renderPermissionPrompt } from './renderPermissionPrompt.ts'

export interface SentPrompts {
  /** Where the delivered copies landed. */
  readonly refs: PromptRef[]
  /**
   * True when some copy could not show the whole input: the request must be
   * treated as high risk (M2).
   */
  readonly hidden: boolean
}

/**
 * Posts a request's prompt and keeps every copy in step with its state.
 * Failures are logged per copy and never thrown: the state is what counts,
 * and an unedited copy only shows stale buttons that the state machine
 * refuses anyway.
 *
 * Nothing is hidden silently (M2): a prompt too long for one message (after
 * redaction) goes out as its whole description and input in plain messages,
 * then the buttons, which say the details are above. If those messages
 * cannot be sent, the buttons come with the middle elided, a note saying how
 * many characters are not shown, and the request becomes high risk.
 */
export class PermissionPrompts {
  constructor(
    /** The redacting decorator from `buildOutbound`. */
    private readonly gateway: PromptGateway,
    /** The redacting, chunking text pipeline from `buildOutbound`, for the details. */
    private readonly chat: ChatGateway,
    private readonly messages: Messages,
    private readonly logger: Logger,
  ) {}

  /** Sends one copy per chat. */
  async send(request: PermissionRequest, chatIds: readonly string[]): Promise<SentPrompts> {
    const refs: PromptRef[] = []
    let hidden = false
    for (const chatId of chatIds) {
      try {
        const sent = await this.#sendOne(request, chatId)
        refs.push(sent.ref)
        hidden ||= sent.hidden
      } catch (error) {
        this.logger.warn('could not send a permission prompt', {
          requestId: request.id,
          chatId,
          error,
        })
      }
    }
    return { refs, hidden }
  }

  async #sendOne(
    request: PermissionRequest,
    chatId: string,
  ): Promise<{ ref: PromptRef; hidden: boolean }> {
    const rendered = renderPermissionPrompt(request, this.messages)
    try {
      const ref = await this.gateway.sendPrompt(chatId, rendered.text, rendered.keyboard, {
        overflow: 'refuse',
      })
      return { ref, hidden: false }
    } catch (error) {
      if (!(error instanceof PromptTooLongError)) throw error
    }
    try {
      await this.chat.sendText(chatId, rendered.details)
    } catch (error) {
      this.logger.warn('could not send the details of a long permission prompt', {
        requestId: request.id,
        chatId,
        error,
      })
      const high = renderPermissionPrompt(request.escalated(), this.messages)
      const ref = await this.gateway.sendPrompt(chatId, high.text, high.keyboard, {
        hiddenNote: this.messages.permissionHidden,
      })
      return { ref, hidden: true }
    }
    const ref = await this.gateway.sendPrompt(chatId, rendered.compact, rendered.keyboard, {
      hiddenNote: this.messages.permissionHidden,
    })
    return { ref, hidden: false }
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
        // Too long once redacted: the middle is elided, and the note says how much.
        await this.gateway.editPrompt(ref, text, keyboard, {
          hiddenNote: this.messages.permissionHidden,
        })
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
