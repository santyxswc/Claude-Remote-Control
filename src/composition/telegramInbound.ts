/**
 * Wires the inbound side of the channel: the Chain of Responsibility from
 * Telegram polling to the session, the button-tap path and the permission
 * relay and the hook listener (F4), under the single-poller lock.
 */
import type { PermissionRequestHandler } from '../adapters/mcp/McpChannelServer.ts'
import type { StateStores } from '../adapters/storage/openState.ts'
import { LOCK_HEARTBEAT_MS } from '../adapters/storage/SqlitePollerLock.ts'
import { type Every, realEvery } from '../adapters/system/every.ts'
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
import type { HookEventSource } from '../application/ports/HookEventSource.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { PermissionVerdictPort } from '../application/ports/PermissionVerdictPort.ts'
import type { PromptGateway } from '../application/ports/PromptGateway.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { ClaimPairing } from '../application/use-cases/ClaimPairing.ts'
import { HandleInboundMessage } from '../application/use-cases/HandleInboundMessage.ts'
import { buildHookListener, type HookListener, type SessionTracking } from './hooks.ts'
import { buildPermissions, type PermissionWiring } from './permissions.ts'

/** While another process polls the bot, check this often whether it has finished. */
const LOCK_RETRY_MS = 30_000

/** How often open permission requests are checked for expiry and confirmation timeouts. */
export const PERMISSION_SWEEP_MS = 5_000

/** What the inbound side needs from the MCP adapter. */
export interface SessionChannel extends ChannelPort, PermissionVerdictPort {
  readonly isConnected: boolean
  onPermissionRequest(handler: PermissionRequestHandler): void
}

export interface TelegramInboundDeps {
  readonly state: StateStores
  readonly token: string
  /** The decorated outbound gateway from `buildOutbound`. */
  readonly chat: ChatGateway & PromptGateway
  readonly channel: SessionChannel
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
  /** Busy/idle and notice debounce, shared with the reply tool. */
  readonly tracking: SessionTracking
  /** Where hook events arrive; without it there are no notices and activity stays unknown. */
  readonly hooks: HookEventSource | undefined
  /** Test seams. */
  readonly fetch?: typeof fetch
  readonly pollTimeoutSeconds?: number
  readonly every?: Every
  readonly session?: string
}

export interface TelegramInbound {
  readonly permissions: PermissionWiring
  stop(): Promise<void>
}

/** Starts polling (or waiting for the lock) and the permission upkeep; `stop` ends both. */
export function startTelegramInbound(deps: TelegramInboundDeps): TelegramInbound {
  const { state, chat, messages, clock, logger } = deps
  const every = deps.every ?? realEvery
  const botUsername = state.identities.load()?.username
  let polling: PollingSupervisor | undefined
  const permissions = buildPermissions({
    state,
    outbound: chat,
    verdicts: deps.channel,
    messages,
    clock,
    logger,
    canRelay: () => polling?.isPolling === true,
    ...(deps.session === undefined ? {} : { session: deps.session }),
  })
  deps.channel.onPermissionRequest((request) => permissions.relay.execute(request))

  const { tracking } = deps
  const forward = new HandleInboundMessage({
    channel: deps.channel,
    chat,
    activity: tracking.activity,
    audit: state.audit,
    clock,
    logger,
    messages,
    onForwarded: () => {
      tracking.policy.ownerWrote(clock.now())
      tracking.activity.messageForwarded()
    },
  })
  const hooks: HookListener | undefined =
    deps.hooks === undefined
      ? undefined
      : buildHookListener({
          state,
          source: deps.hooks,
          chat,
          tracking,
          permissions,
          messages,
          clock,
          logger,
          every,
        })
  const commands = createCommandRegistry({
    messages,
    botUsername,
    allowed: state.allowed,
    isSessionConnected: () => deps.channel.isConnected,
    pendingPermissions: permissions.pendingCount,
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
      permissionVerdicts: permissions.verdictStep,
    }),
  })
  polling = new PollingSupervisor({
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
    callbackHandler: (callback) => permissions.callbacks.handle(callback),
    // Requests relayed by an earlier poller can no longer be answered from the chat.
    onPollingStarted: () => {
      void guarded(logger, 'expiring orphaned permission requests', () =>
        permissions.expire.expireOrphans(),
      )
      hooks?.onPollingStarted()
    },
    onPollingStopped: () => hooks?.onPollingStopped(),
    logger,
    role: 'channel',
    heartbeatMs: LOCK_HEARTBEAT_MS,
    retryMs: LOCK_RETRY_MS,
    every,
  })

  let sweeping = false
  const cancelSweep = every(PERMISSION_SWEEP_MS, () => {
    if (sweeping) return
    sweeping = true
    void guarded(logger, 'permission expiry sweep', () => permissions.expire.execute()).finally(
      () => {
        sweeping = false
      },
    )
  })

  polling.start()
  const supervisor = polling
  return {
    permissions,
    async stop() {
      cancelSweep()
      await supervisor.stop()
      await hooks?.stop()
    },
  }
}

/** Background work must never become an unhandled rejection. */
async function guarded(logger: Logger, what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    logger.error(`${what} failed`, { error })
  }
}
