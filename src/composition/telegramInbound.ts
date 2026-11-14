/**
 * Wires the inbound side of the channel: the Chain of Responsibility from
 * Telegram polling to the session, under the single-poller lock.
 */
import { UnknownSessionActivity } from '../adapters/session/UnknownSessionActivity.ts'
import type { StateStores } from '../adapters/storage/openState.ts'
import { LOCK_HEARTBEAT_MS } from '../adapters/storage/SqlitePollerLock.ts'
import { Sha256SecretHasher } from '../adapters/system/Sha256SecretHasher.ts'
import { PollingSupervisor } from '../adapters/telegram/PollingSupervisor.ts'
import { TelegramPoller } from '../adapters/telegram/TelegramPoller.ts'
import { createCommandRegistry } from '../application/commands/createCommandRegistry.ts'
import type { Messages } from '../application/i18n/messages.ts'
import { createInboundPipeline } from '../application/pipeline/createInboundPipeline.ts'
import { createSessionSteps } from '../application/pipeline/createSessionSteps.ts'
import type { ChannelPort } from '../application/ports/ChannelPort.ts'
import type { ChatGateway } from '../application/ports/ChatGateway.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { Logger } from '../application/ports/Logger.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { ClaimPairing } from '../application/use-cases/ClaimPairing.ts'
import { HandleInboundMessage } from '../application/use-cases/HandleInboundMessage.ts'

/** While another process polls the bot, check this often whether it has finished. */
const LOCK_RETRY_MS = 30_000

export interface TelegramInboundDeps {
  readonly state: StateStores
  readonly token: string
  /** The decorated outbound gateway from `buildOutbound`. */
  readonly chat: ChatGateway
  readonly channel: ChannelPort & { readonly isConnected: boolean }
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
  /** Test seams for the poller. */
  readonly fetch?: typeof fetch
  readonly pollTimeoutSeconds?: number
}

/** Starts polling (or waiting for the lock) and returns the supervisor to stop it. */
export function startTelegramInbound(deps: TelegramInboundDeps): PollingSupervisor {
  const { state, chat, messages, clock, logger } = deps
  const botUsername = state.identities.load()?.username
  const forward = new HandleInboundMessage({
    channel: deps.channel,
    chat,
    activity: new UnknownSessionActivity(),
    audit: state.audit,
    clock,
    logger,
    messages,
  })
  const commands = createCommandRegistry({
    messages,
    botUsername,
    allowed: state.allowed,
    isSessionConnected: () => deps.channel.isConnected,
  })
  const pipeline = createInboundPipeline({
    claimPairing: new ClaimPairing({
      pairings: state.pairings,
      audit: state.audit,
      hasher: new Sha256SecretHasher(),
      clock,
    }),
    authorizeSender: new AuthorizeSender(state.allowed),
    chat,
    messages,
    logger,
    clock,
    afterAuthentication: createSessionSteps({
      chat,
      messages,
      logger,
      clock,
      audit: state.audit,
      commands,
      forward,
      botUsername,
    }),
  })
  const polling = new PollingSupervisor({
    lock: state.lock,
    poller: new TelegramPoller({
      token: deps.token,
      logger,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.pollTimeoutSeconds === undefined
        ? {}
        : { pollTimeoutSeconds: deps.pollTimeoutSeconds }),
    }),
    handler: pipeline,
    logger,
    role: 'channel',
    heartbeatMs: LOCK_HEARTBEAT_MS,
    retryMs: LOCK_RETRY_MS,
  })
  polling.start()
  return polling
}
