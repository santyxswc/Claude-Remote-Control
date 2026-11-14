import type { AnswerChoiceWithText } from '../use-cases/AnswerChoiceWithText.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * After the brake gate (F7): when a choice of this chat waits for a typed
 * answer ("Other..."), this text is that answer. It is delivered like any
 * other message, only tagged with the choice it answers. Commands ran
 * earlier, so `/stop` is never taken for an answer; while braked nothing
 * gets here and the choice keeps waiting.
 */
export class ChoiceTextAnswerStep implements InboundStep {
  constructor(private readonly answer: Pick<AnswerChoiceWithText, 'execute'>) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    const { sender } = message
    if (
      message.text === undefined ||
      sender === undefined ||
      message.forwardContext !== undefined
    ) {
      await next(message)
      return
    }
    const choiceId = await this.answer.execute({ chatId: message.chatId, sender })
    await next(
      choiceId === undefined
        ? message
        : { ...message, forwardContext: { kind: 'choice', choiceId } },
    )
  }
}
