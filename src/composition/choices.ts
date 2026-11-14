/**
 * Wires F7's `ask_choice`: the four use cases around the choice store, all
 * scoped to this process's session (like permission requests, ADR 0007).
 */
import type { StateStores } from '../adapters/storage/openState.ts'
import { CryptoRandomSource } from '../adapters/system/CryptoRandomSource.ts'
import { ChoicePrompts } from '../application/choices/ChoicePrompts.ts'
import type { Messages } from '../application/i18n/messages.ts'
import type { ChatGateway } from '../application/ports/ChatGateway.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { PromptGateway } from '../application/ports/PromptGateway.ts'
import { AnswerChoice } from '../application/use-cases/AnswerChoice.ts'
import { AnswerChoiceWithText } from '../application/use-cases/AnswerChoiceWithText.ts'
import { AskChoice } from '../application/use-cases/AskChoice.ts'
import { AuthorizeReplyTarget } from '../application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { ExpireChoices } from '../application/use-cases/ExpireChoices.ts'
import type { HandleInboundMessage } from '../application/use-cases/HandleInboundMessage.ts'

export interface ChoiceWiringDeps {
  readonly state: Pick<StateStores, 'choices' | 'allowed' | 'audit' | 'brake'>
  /** The decorated gateway from `buildOutbound`. */
  readonly outbound: ChatGateway & PromptGateway
  /** The delivery used for typed text, so a choice is delivered exactly like it. */
  readonly forward: HandleInboundMessage
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
  /** True while this process polls the bot (and so can receive taps). */
  readonly canAsk: () => boolean
}

export interface ChoiceWiring {
  readonly ask: AskChoice
  readonly answer: AnswerChoice
  readonly answerWithText: AnswerChoiceWithText
  readonly expire: ExpireChoices
}

export function buildChoices(deps: ChoiceWiringDeps): ChoiceWiring {
  const { state, clock, logger, session } = deps
  const store = state.choices
  const prompts = new ChoicePrompts(deps.outbound, deps.outbound, deps.messages, logger)
  const authorize = new AuthorizeSender(state.allowed)
  const common = { store, prompts, audit: state.audit, clock, logger, session }
  return {
    ask: new AskChoice({
      ...common,
      // Buttons exist only on Telegram: no extra (dev) chats.
      target: new AuthorizeReplyTarget(authorize),
      random: new CryptoRandomSource(),
      canAsk: deps.canAsk,
    }),
    answer: new AnswerChoice({ ...common, forward: deps.forward, authorize, brake: state.brake }),
    answerWithText: new AnswerChoiceWithText(common),
    expire: new ExpireChoices(common),
  }
}
