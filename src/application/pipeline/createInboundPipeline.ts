import type { Messages } from '../i18n/messages.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Logger } from '../ports/Logger.ts'
import type { AuthorizeSender } from '../use-cases/AuthorizeSender.ts'
import type { ClaimPairing } from '../use-cases/ClaimPairing.ts'
import { AuthenticateSenderStep } from './AuthenticateSenderStep.ts'
import { DiscardStep } from './DiscardStep.ts'
import { buildPipeline, type InboundHandler, type InboundStep } from './InboundStep.ts'
import { PairingClaimStep } from './PairingClaimStep.ts'
import { PrivateChatOnlyStep } from './PrivateChatOnlyStep.ts'

export interface InboundPipelineDeps {
  readonly claimPairing: ClaimPairing
  readonly authorizeSender: AuthorizeSender
  /** Only used to acknowledge a successful pairing claim. */
  readonly chat: ChatGateway
  readonly messages: Messages
  readonly logger: Logger
  /** What authenticated messages reach; F2 replaces the default discard. */
  readonly deliver?: InboundStep
}

/** The inbound chain, in the order the security model requires. */
export function createInboundPipeline(deps: InboundPipelineDeps): InboundHandler {
  return buildPipeline([
    new PrivateChatOnlyStep(deps.logger),
    new PairingClaimStep(deps.claimPairing, deps.chat, deps.messages, deps.logger),
    new AuthenticateSenderStep(deps.authorizeSender, deps.logger),
    deps.deliver ?? new DiscardStep(),
  ])
}
