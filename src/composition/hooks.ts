/**
 * Wires F4: the hook IPC listener (only while this process polls Telegram),
 * the router and the two use cases fed by hooks, plus the shared session
 * state that the reply tool and the inbound chain report to.
 */
import { hookEndpoint } from '../adapters/ipc/endpoint.ts'
import { HookIpcServer } from '../adapters/ipc/HookIpcServer.ts'
import { loadOrCreateHookSecret } from '../adapters/ipc/hookSecret.ts'
import type { StateStores } from '../adapters/storage/openState.ts'
import { CryptoRandomSource } from '../adapters/system/CryptoRandomSource.ts'
import type { Every } from '../adapters/system/every.ts'
import { HookEventRouter } from '../application/hooks/HookEventRouter.ts'
import type { Messages } from '../application/i18n/messages.ts'
import type { ChatGateway } from '../application/ports/ChatGateway.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { HookEventSource } from '../application/ports/HookEventSource.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { StatusBoard } from '../application/status/StatusBoard.ts'
import { NotifySessionEvent } from '../application/use-cases/NotifySessionEvent.ts'
import { TrackSessionActivity } from '../application/use-cases/TrackSessionActivity.ts'
import { NoticePolicy } from '../domain/notices/NoticePolicy.ts'
import type { PermissionWiring } from './permissions.ts'

/** While another live process holds the endpoint, try again this often. */
export const HOOK_LISTEN_RETRY_MS = 10_000

/** What the session tells us outside hooks: replies sent, messages forwarded. */
export interface SessionTracking {
  readonly policy: NoticePolicy
  readonly activity: TrackSessionActivity
}

export function createSessionTracking(clock: Clock): SessionTracking {
  return { policy: new NoticePolicy(), activity: new TrackSessionActivity(clock) }
}

/** The real listener for a state directory; creates the shared secret on first use. */
export function createHookIpcServer(stateDir: string, logger: Logger): HookEventSource {
  return new HookIpcServer({
    endpoint: hookEndpoint(stateDir),
    secret: loadOrCreateHookSecret(stateDir, new CryptoRandomSource()),
    logger,
  })
}

export interface HookWiringDeps {
  readonly state: StateStores
  readonly source: HookEventSource
  /** The decorated gateway from `buildOutbound`. */
  readonly chat: ChatGateway
  readonly tracking: SessionTracking
  readonly permissions: PermissionWiring
  /** The pinned status (F9), fed by the same events. */
  readonly status?: Pick<StatusBoard, 'record'>
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
  readonly every: Every
}

export interface HookListener {
  /** For `PollingSupervisor`: only the poller can talk to Telegram, so only it listens. */
  onPollingStarted(): void
  onPollingStopped(): void
  stop(): Promise<void>
}

export function buildHookListener(deps: HookWiringDeps): HookListener {
  const { source, tracking, clock, logger } = deps
  const router = new HookEventRouter({
    notify: new NotifySessionEvent({
      chat: deps.chat,
      allowed: deps.state.allowed,
      policy: tracking.policy,
      lastPermissionRelayAt: deps.permissions.lastRelayedAt,
      messages: deps.messages,
      audit: deps.state.audit,
      clock,
      logger,
    }),
    activity: tracking.activity,
    policy: tracking.policy,
    markResolvedLocally: (resolution) => deps.permissions.markResolvedLocally.execute(resolution),
    ...(deps.status === undefined ? {} : { status: deps.status }),
    clock,
    logger,
  })
  const handler = (payload: unknown) => router.handle(payload)

  let wanted = false
  let cancelRetry: (() => void) | undefined
  const clearRetry = (): void => {
    cancelRetry?.()
    cancelRetry = undefined
  }
  const tryListen = async (): Promise<void> => {
    const result = await source.start(handler)
    if (!wanted) return source.stop() // polling ended while we were starting
    if (result === 'listening') return clearRetry()
    if (result === 'in_use' && cancelRetry === undefined) {
      logger.info('another process still holds the hook endpoint; retrying')
      cancelRetry = deps.every(HOOK_LISTEN_RETRY_MS, () => void guarded(logger, tryListen))
    }
  }

  return {
    onPollingStarted() {
      wanted = true
      void guarded(logger, tryListen)
    },
    onPollingStopped() {
      wanted = false
      clearRetry()
      void guarded(logger, () => source.stop())
    },
    async stop() {
      wanted = false
      clearRetry()
      await source.stop()
    },
  }
}

async function guarded(logger: Logger, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    logger.error('the hook listener failed', { error })
  }
}
