import type { Choice } from '../../domain/choices/Choice.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import { PromptTooLongError } from '../errors.ts'
import type { ChoiceStatusView, Messages } from '../i18n/messages.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PromptGateway, PromptKeyboard } from '../ports/PromptGateway.ts'
import { encodeChoiceCallback } from './choiceCallbackData.ts'

/** One option per row: labels can be up to 64 characters. */
export function choiceKeyboard(choice: Choice, messages: Messages): PromptKeyboard {
  if (choice.state !== 'pending') return []
  const rows = choice.options.map((label, index) => [
    { label, data: encodeChoiceCallback(choice.id, index) },
  ])
  return choice.allowOther
    ? [
        ...rows,
        [{ label: messages.choiceOtherButton, data: encodeChoiceCallback(choice.id, 'other') }],
      ]
    : rows
}

/**
 * Posts a choice and keeps its message in step with its state. The
 * question is Claude's text: it goes out whole through the redacting
 * gateway and is fitted only after redaction (M3). A question too long for
 * one message is sent in plain messages first and the buttons follow with a
 * note that it is above, so nothing is hidden (M2).
 */
export class ChoicePrompts {
  constructor(
    /** The redacting decorator from `buildOutbound` (labels are redacted too). */
    private readonly gateway: PromptGateway,
    /** The redacting, chunking text pipeline from `buildOutbound`, for a long question. */
    private readonly chat: ChatGateway,
    private readonly messages: Messages,
    private readonly logger: Logger,
  ) {}

  /** Rejects when the buttons could not be delivered. */
  async send(choice: Choice): Promise<PromptRef> {
    const keyboard = choiceKeyboard(choice, this.messages)
    try {
      return await this.gateway.sendPrompt(
        choice.chatId,
        this.messages.choicePrompt(choice.question),
        keyboard,
        { overflow: 'refuse' },
      )
    } catch (error) {
      if (!(error instanceof PromptTooLongError)) throw error
    }
    await this.chat.sendText(choice.chatId, this.messages.choicePrompt(choice.question))
    return this.gateway.sendPrompt(choice.chatId, this.messages.choiceQuestionAbove, keyboard)
  }

  /**
   * Shows how the choice ended and removes the buttons. The message keeps the
   * question, or says it is above when it no longer fits (it was sent whole).
   */
  async refresh(
    choice: Choice,
    status: ChoiceStatusView,
    /** The tapped message, for a tap that arrives before the ref was stored. */
    ref: PromptRef | undefined = choice.prompt,
  ): Promise<void> {
    if (ref === undefined) return
    const keyboard = choiceKeyboard(choice, this.messages)
    const line = this.messages.choiceStatus(status)
    try {
      try {
        await this.gateway.editPrompt(
          ref,
          `${this.messages.choicePrompt(choice.question)}\n\n${line}`,
          keyboard,
          { overflow: 'refuse' },
        )
      } catch (error) {
        if (!(error instanceof PromptTooLongError)) throw error
        await this.gateway.editPrompt(
          ref,
          `${this.messages.choiceQuestionAbove}\n\n${line}`,
          keyboard,
        )
      }
    } catch (error) {
      this.logger.warn('could not update a choice message', { choiceId: choice.id, error })
    }
  }
}
