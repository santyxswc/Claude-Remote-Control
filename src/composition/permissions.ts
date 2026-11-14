/**
 * Wires the permission relay: the four use cases around one store, the
 * button-tap path and the text-verdict step of the inbound chain.
 */
import type { StateStores } from '../adapters/storage/openState.ts'
import { CryptoRandomSource } from '../adapters/system/CryptoRandomSource.ts'
import { PermissionCallbackHandler } from '../application/callbacks/PermissionCallbackHandler.ts'
import type { Messages } from '../application/i18n/messages.ts'
import { PermissionPrompts } from '../application/permissions/PermissionPrompts.ts'
import { PermissionVerdictStep } from '../application/pipeline/PermissionVerdictStep.ts'
import type { ChatGateway } from '../application/ports/ChatGateway.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { PermissionVerdictPort } from '../application/ports/PermissionVerdictPort.ts'
import type { PromptGateway } from '../application/ports/PromptGateway.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { ExpirePermissions } from '../application/use-cases/ExpirePermissions.ts'
import { MarkPermissionResolvedLocally } from '../application/use-cases/MarkPermissionResolvedLocally.ts'
import { RelayPermissionRequest } from '../application/use-cases/RelayPermissionRequest.ts'
import { ResolvePermission } from '../application/use-cases/ResolvePermission.ts'
import { encodeBase64Url } from '../domain/base64url.ts'
import { PatternRiskPolicy } from '../domain/permissions/RiskPolicy.ts'

export interface PermissionWiringDeps {
  readonly state: StateStores
  /** The decorated gateway from `buildOutbound`. */
  readonly outbound: ChatGateway & PromptGateway
  readonly verdicts: PermissionVerdictPort
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
  /** True while this process polls the bot (and so can receive taps). */
  readonly canRelay: () => boolean
  /** Test seam; a random id per process by default. */
  readonly session?: string
}

export interface PermissionWiring {
  /** This process's id on its permission requests. */
  readonly session: string
  readonly relay: RelayPermissionRequest
  readonly resolve: ResolvePermission
  readonly expire: ExpirePermissions
  /** For F4's `PostToolUse` hook. */
  readonly markResolvedLocally: MarkPermissionResolvedLocally
  readonly callbacks: PermissionCallbackHandler
  readonly verdictStep: PermissionVerdictStep
  /** Open requests of this process, for `/status`. */
  readonly pendingCount: () => number
  /** When this process last relayed a still-open request that reached a chat, for F4. */
  readonly lastRelayedAt: () => number | undefined
}

export function buildPermissions(deps: PermissionWiringDeps): PermissionWiring {
  const { state, messages, clock, logger } = deps
  const session = deps.session ?? encodeBase64Url(new CryptoRandomSource().bytes(9))
  const store = state.permissions
  const prompts = new PermissionPrompts(deps.outbound, messages, logger)
  const authorize = new AuthorizeSender(state.allowed)
  const common = { store, prompts, audit: state.audit, clock, logger, session }
  const resolve = new ResolvePermission({
    ...common,
    verdicts: deps.verdicts,
    authorize,
    brake: state.brake,
  })
  return {
    session,
    relay: new RelayPermissionRequest({
      ...common,
      allowed: state.allowed,
      risk: new PatternRiskPolicy(),
      canRelay: deps.canRelay,
      brake: state.brake,
      verdicts: deps.verdicts,
    }),
    resolve,
    expire: new ExpirePermissions(common),
    markResolvedLocally: new MarkPermissionResolvedLocally(common),
    callbacks: new PermissionCallbackHandler({
      authorize,
      resolve,
      prompts: deps.outbound,
      messages,
      clock,
      logger,
    }),
    verdictStep: new PermissionVerdictStep(resolve, deps.outbound, messages, logger),
    pendingCount: () => store.listOpen().filter((request) => request.session === session).length,
    lastRelayedAt: () => {
      const relayed = store
        .listOpen()
        .filter((request) => request.session === session && request.prompts.length > 0)
      return relayed.at(-1)?.createdAt
    },
  }
}
