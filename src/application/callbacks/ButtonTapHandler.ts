import { EventThrottle } from '../../domain/EventThrottle.ts'
import { DROPPED_LOG_WINDOW_MS } from '../../domain/inboundLimits.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import { TokenBucket } from '../../domain/TokenBucket.ts'
import { parseChoiceCallback } from '../choices/choiceCallbackData.ts'
import { parseGitCallback } from '../git/gitCallbackData.ts'
import type { Messages } from '../i18n/messages.ts'
import { parseMemoryCallback } from '../memory/memoryCallbackData.ts'
import { parsePermissionCallback } from '../permissions/callbackData.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PromptGateway } from '../ports/PromptGateway.ts'
import type { SkillsMenu } from '../skills/SkillsMenu.ts'
import { parseSkillCallback } from '../skills/skillCallbackData.ts'
import type { AnswerChoice } from '../use-cases/AnswerChoice.ts'
import type { AuthorizeSender } from '../use-cases/AuthorizeSender.ts'
import type { RequestGitAction } from '../use-cases/RequestGitAction.ts'
import type { RequestSkill } from '../use-cases/RequestSkill.ts'
import type { ResolveMemoryProposal } from '../use-cases/ResolveMemoryProposal.ts'
import type { ResolvePermission } from '../use-cases/ResolvePermission.ts'
import type { ResolveVoiceTranscript } from '../use-cases/ResolveVoiceTranscript.ts'
import { parseVoiceCallback } from '../voice/voiceCallbackData.ts'
import type { InboundCallback } from './InboundCallback.ts'

export interface ButtonTapHandlerDeps {
  readonly authorize: AuthorizeSender
  /** Permission buttons (`p1:`), the only route that can produce a verdict. */
  readonly resolve: ResolvePermission
  /** Choice buttons (`c1:`, F7); without it they are ignored. */
  readonly choices?: Pick<AnswerChoice, 'execute'>
  /** `/skills` buttons (`k1:`, F7); without them they are ignored. */
  readonly skills?: {
    readonly menu: Pick<SkillsMenu, 'showPage'>
    readonly request: Pick<RequestSkill, 'execute'>
  }
  /** `/diff` buttons (`g1:`, F8): fixed instructions to the session; without it they are ignored. */
  readonly git?: Pick<RequestGitAction, 'execute'>
  /** Memory proposal buttons (`m1:`, F12): Approve writes the shown lines; without it they are ignored. */
  readonly memory?: Pick<ResolveMemoryProposal, 'execute'>
  /** Voice transcript buttons (`v1:`, F13): Send feeds the shown text to the transcript chain; without it they are ignored. */
  readonly voice?: Pick<ResolveVoiceTranscript, 'execute'>
  /** Only `answerCallback` is used here. */
  readonly prompts: Pick<PromptGateway, 'answerCallback'>
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
  readonly limiter?: TokenBucket
}

/** A tap that passed authentication, from the sender's own private chat. */
interface AuthorizedTap {
  readonly sender: SenderProfile
  readonly chatId: string
  readonly messageId: string | undefined
}

/**
 * The authenticated path for every button tap, the twin of the message
 * chain: private chat only, the chat must be the sender's own, sender
 * allowlisted by user id, rate limited. A tap that fails the first checks is
 * dropped without even answering it, like a message from a stranger.
 * Allowlisted taps are always answered so the client's spinner stops.
 *
 * Then the data is routed by its versioned prefix. Each parser is strict and
 * anchored and the prefixes differ, so a choice, skill, git, memory or voice button can never
 * reach `ResolvePermission`, nor a permission button anything else.
 * Unknown data is answered with nothing.
 */
export class ButtonTapHandler {
  readonly #limiter: TokenBucket
  readonly #dropLog = new EventThrottle(DROPPED_LOG_WINDOW_MS)

  constructor(private readonly deps: ButtonTapHandlerDeps) {
    this.#limiter = deps.limiter ?? new TokenBucket()
  }

  async handle(callback: InboundCallback): Promise<void> {
    const { sender, chatId } = callback
    const { logger } = this.deps
    const now = this.deps.clock.now()
    if (
      callback.chatKind !== 'private' ||
      sender === undefined ||
      chatId !== sender.id ||
      !this.deps.authorize.execute(sender.id)
    ) {
      const senderId = sender?.id ?? null
      const decision = this.#dropLog.record(senderId ?? 'unknown', now)
      if (decision.emit)
        logger.info('dropped a button tap from an unauthorized sender', { senderId })
      return
    }

    if (!this.#limiter.take(sender.id, now).allowed) {
      await this.#answer(callback.id)
      return
    }
    let text: string | undefined
    try {
      text = await this.#route(callback.data, { sender, chatId, messageId: callback.messageId })
    } catch (error) {
      logger.error('handling a button tap failed', { error })
    }
    await this.#answer(callback.id, text)
  }

  /** The toast for the tap, if any. */
  async #route(data: string | undefined, tap: AuthorizedTap): Promise<string | undefined> {
    const { messages, logger } = this.deps
    const permission = parsePermissionCallback(data)
    if (permission !== undefined) {
      const outcome = await this.deps.resolve.execute({
        ...permission,
        sender: tap.sender,
        via: 'button',
      })
      return messages.permissionFeedback(outcome)
    }
    const choice = parseChoiceCallback(data)
    if (choice !== undefined && this.deps.choices !== undefined) {
      const outcome = await this.deps.choices.execute({ ...choice, ...tap })
      return messages.choiceFeedback(outcome)
    }
    const skill = parseSkillCallback(data)
    const skills = this.deps.skills
    if (skill !== undefined && skills !== undefined) {
      if (skill.kind === 'page') {
        if (tap.messageId !== undefined) {
          await skills.menu.showPage({ chatId: tap.chatId, messageId: tap.messageId }, skill.page)
        }
        return undefined
      }
      return messages.skillFeedback(await skills.request.execute({ key: skill.key, ...tap }))
    }
    const git = parseGitCallback(data)
    if (git !== undefined && this.deps.git !== undefined) {
      return messages.gitTapFeedback(await this.deps.git.execute({ ...git, ...tap }))
    }
    const memory = parseMemoryCallback(data)
    if (memory !== undefined && this.deps.memory !== undefined) {
      return messages.memoryFeedback(await this.deps.memory.execute({ ...memory, ...tap }))
    }
    const voice = parseVoiceCallback(data)
    if (voice !== undefined && this.deps.voice !== undefined) {
      return messages.voiceFeedback(await this.deps.voice.execute({ ...voice, ...tap }))
    }
    logger.warn('ignored a button tap with unknown data', { senderId: tap.sender.id })
    return undefined
  }

  async #answer(callbackId: string, text?: string): Promise<void> {
    try {
      await this.deps.prompts.answerCallback(callbackId, text)
    } catch (error) {
      this.deps.logger.warn('could not answer a button tap', { error })
    }
  }
}
