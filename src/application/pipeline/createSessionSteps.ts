import { TokenBucket } from '../../domain/TokenBucket.ts'
import type { CommandRegistry } from '../commands/CommandRegistry.ts'
import type { Messages } from '../i18n/messages.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { AnswerChoiceWithText } from '../use-cases/AnswerChoiceWithText.ts'
import type { HandleInboundMessage } from '../use-cases/HandleInboundMessage.ts'
import type { ReceiveAttachment } from '../use-cases/ReceiveAttachment.ts'
import { AttachmentStep } from './AttachmentStep.ts'
import { BrakeGateStep } from './BrakeGateStep.ts'
import { ChoiceTextAnswerStep } from './ChoiceTextAnswerStep.ts'
import { CommandRouterStep } from './CommandRouterStep.ts'
import { ForwardToSessionStep } from './ForwardToSessionStep.ts'
import type { InboundStep } from './InboundStep.ts'
import type { PermissionVerdictStep } from './PermissionVerdictStep.ts'
import { RateLimitStep } from './RateLimitStep.ts'
import { UnsupportedContentStep } from './UnsupportedContentStep.ts'

export interface SessionStepsDeps {
  readonly chat: ChatGateway
  readonly messages: Messages
  readonly logger: Logger
  readonly clock: Clock
  readonly audit: AuditLog
  readonly commands: CommandRegistry
  readonly forward: HandleInboundMessage
  readonly botUsername: string | undefined
  readonly limiter?: TokenBucket
  /** Text verdicts for permission prompts; absent when the relay is off. */
  readonly permissionVerdicts?: PermissionVerdictStep
  /** The panic brake; while engaged nothing is delivered to the session. */
  readonly brake?: Pick<BrakeFlag, 'status'>
  /** Typed answers after "Other..." (F7). */
  readonly choiceAnswers?: Pick<AnswerChoiceWithText, 'execute'>
  /** Photos and files (F10); without it they get the "only text" notice. */
  readonly attachments?: Pick<ReceiveAttachment, 'start'>
}

/**
 * The tail of the chain for the channel process, after authentication:
 * rate limit, supported content only, permission verdicts, commands, the
 * brake gate, then incoming files, typed choice answers and delivery to the
 * session.
 */
export function createSessionSteps(deps: SessionStepsDeps): InboundStep[] {
  return [
    new RateLimitStep({
      limiter: deps.limiter ?? new TokenBucket(),
      clock: deps.clock,
      chat: deps.chat,
      audit: deps.audit,
      logger: deps.logger,
      slowDown: deps.messages.slowDown,
    }),
    new UnsupportedContentStep(
      deps.chat,
      deps.messages.onlyTextSupported,
      deps.clock,
      deps.logger,
      deps.attachments !== undefined,
    ),
    ...(deps.permissionVerdicts === undefined ? [] : [deps.permissionVerdicts]),
    new CommandRouterStep(deps.commands, deps.chat, deps.logger, deps.botUsername),
    ...(deps.brake === undefined
      ? []
      : [
          new BrakeGateStep(
            deps.brake,
            deps.chat,
            deps.messages.brakeHeldMessage,
            deps.clock,
            deps.logger,
          ),
        ]),
    ...(deps.attachments === undefined ? [] : [new AttachmentStep(deps.attachments)]),
    ...(deps.choiceAnswers === undefined ? [] : [new ChoiceTextAnswerStep(deps.choiceAnswers)]),
    new ForwardToSessionStep(deps.forward),
  ]
}
