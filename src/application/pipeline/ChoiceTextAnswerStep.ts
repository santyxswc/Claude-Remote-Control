import type { AnswerChoiceWithText } from '../use-cases/AnswerChoiceWithText.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * After the brake gate (F7): when a choice of this chat waits for a typed
 * answer ("Other..."), this text is that answer. It is delivered like any
 * other message, only tagged with the choice it answers. Commands ran
 * earlier, so `/stop` is never taken for an answer; while braked nothing
 * gets here and the choice keeps waiting.
 *
 * A voice transcript the owner confirmed with Send (F13) counts as typed
 * text here: the owner read it and chose to send it. It keeps its
 * transcript id in the meta.
 */
export class ChoiceTextAnswerStep implements InboundStep {
  constructor(private readonly answer: Pick<AnswerChoiceWithText, 'execute'>) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    const { sender } = message
    const context = message.forwardContext
    if (
      message.text === undefined ||
      sender === undefined ||
      (context !== undefined && context.kind !== 'voice')
    ) {
      await next(message)
      return
    }
    const choiceId = await this.answer.execute({ chatId: message.chatId, sender })
    await next(
      choiceId === undefined
        ? message
        : {
            ...message,
            forwardContext: {
              kind: 'choice',
              choiceId,
              ...(context === undefined ? {} : { transcriptId: context.transcriptId }),
            },
          },
    )
  }
}
