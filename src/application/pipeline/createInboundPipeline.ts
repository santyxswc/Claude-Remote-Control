import type { Messages } from '../i18n/messages.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { AuthorizeSender } from '../use-cases/AuthorizeSender.ts'
import type { ClaimPairing } from '../use-cases/ClaimPairing.ts'
import { AuthenticateSenderStep } from './AuthenticateSenderStep.ts'
import { buildPipeline, type InboundHandler, type InboundStep } from './InboundStep.ts'
import { PairingClaimStep } from './PairingClaimStep.ts'
import { PrivateChatOnlyStep } from './PrivateChatOnlyStep.ts'

export interface InboundPipelineDeps {
  readonly claimPairing: ClaimPairing
  readonly authorizeSender: AuthorizeSender
  /** The decorated outbound gateway; here only for the pairing acknowledgement. */
  readonly chat: ChatGateway
  readonly messages: Messages
  readonly logger: Logger
  readonly clock: Clock
  /**
   * What authenticated messages go through next (see `createSessionSteps`).
   * Empty for the `pair` CLI, which has no session: they are dropped.
   */
  readonly afterAuthentication?: readonly InboundStep[]
}

/** The inbound chain, in the order the security model requires. */
export function createInboundPipeline(deps: InboundPipelineDeps): InboundHandler {
  return buildPipeline([
    new PrivateChatOnlyStep(deps.logger, deps.clock),
    new PairingClaimStep(deps.claimPairing, deps.chat, deps.messages, deps.logger),
    new AuthenticateSenderStep(deps.authorizeSender, deps.logger, deps.clock),
    ...(deps.afterAuthentication ?? []),
  ])
}
