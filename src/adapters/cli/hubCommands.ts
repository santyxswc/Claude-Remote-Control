import type { Messages } from '../../application/i18n/messages.ts'
import type { InboundHandler } from '../../application/pipeline/InboundStep.ts'
import type { AuditLog } from '../../application/ports/AuditLog.ts'
import type { Clock } from '../../application/ports/Clock.ts'
import type { GroupBindingStore } from '../../application/ports/GroupBindingStore.ts'
import type { HubGroup, HubGroupStore } from '../../application/ports/HubGroupStore.ts'
import type { InboundPoller, PollingExit } from '../../application/ports/InboundPoller.ts'
import type { PollerLock } from '../../application/ports/PollerLock.ts'
import type { Terminal } from '../../application/ports/Terminal.ts'
import type { AwaitPairingClaim } from '../../application/use-cases/AwaitPairingClaim.ts'
import type { ConfirmGroupBinding } from '../../application/use-cases/ConfirmGroupBinding.ts'
import type { StartPairing } from '../../application/use-cases/StartPairing.ts'
import type { Pairing } from '../../domain/Pairing.ts'
import type { Every } from '../system/every.ts'
import type { GroupRightsProbe } from '../telegram/TelegramGroupProbe.ts'
import { EXIT_FAILURE, EXIT_OK } from './exitCodes.ts'

/** Audit actor for everything done from this CLI. */
const ACTOR = 'terminal'

/** Everything `hub init` needs once the bot is configured and an owner is paired. */
export interface HubInitSession {
  readonly botUsername: string
  readonly hasOwner: boolean
  /** `StartPairing` over the bindings table; its "link" is the `/bind@bot <code>` command. */
  readonly startBinding: StartPairing
  readonly awaitClaim: AwaitPairingClaim
  readonly confirmBinding: ConfirmGroupBinding
  readonly bindings: GroupBindingStore
  readonly lock: PollerLock
  readonly createPoller: () => InboundPoller
  /** `GroupBindingClaimHandler`: `/bind <code>` from the owner, in a forum supergroup. */
  readonly handler: InboundHandler
  readonly rights: (chatId: string) => GroupRightsProbe
}

export interface HubInitDeps {
  readonly terminal: Terminal
  readonly messages: Messages
  readonly clock: Clock
  readonly every: Every
  readonly heartbeatMs: number
  /** Undefined when there is no token or bot identity yet. */
  readonly session: HubInitSession | undefined
}

type Waited =
  | { readonly kind: 'binding'; readonly binding: Pairing }
  | { readonly kind: 'polling-ended'; readonly exit: PollingExit }

/**
 * `hub init` (F14): binds the bot to one forum supergroup with the pairing
 * mechanics of F1. This command polls by itself, so no other process may
 * poll meanwhile; the code works once, for 120 s, only from an allowlisted
 * account, and nothing is bound until the owner confirms here.
 */
export async function runHubInit(deps: HubInitDeps): Promise<number> {
  const { terminal, messages, session } = deps
  if (session === undefined) {
    terminal.error(messages.notConfigured)
    return EXIT_FAILURE
  }
  if (!session.hasOwner) {
    terminal.error(messages.hubInitNotPaired)
    return EXIT_FAILURE
  }
  const lock = session.lock.tryAcquire('cli')
  if (!lock.acquired) {
    terminal.error(messages.hubInitBusy(lock.holder.role, lock.holder.pid))
    return EXIT_FAILURE
  }

  const poller = session.createPoller()
  const stopHeartbeat = deps.every(deps.heartbeatMs, () => session.lock.refresh())
  const waiting = new AbortController()
  const pollingEnded = poller
    .start(session.handler)
    .then((exit): Waited => ({ kind: 'polling-ended', exit }))

  let outcome: Waited
  try {
    const started = session.startBinding.execute()
    terminal.print(messages.hubInitInstructions(session.botUsername))
    terminal.print(messages.hubInitSend(started.link))
    const seconds = Math.max(0, Math.round((started.expiresAt - deps.clock.now()) / 1000))
    terminal.print(messages.hubInitExpiresIn(seconds))
    const claimed = session.awaitClaim
      .execute(started.pairingId, waiting.signal)
      .then((binding): Waited => ({ kind: 'binding', binding }))
    outcome = await Promise.race([claimed, pollingEnded])
  } finally {
    // Stop listening before asking anything: nobody else can claim from now on.
    waiting.abort()
    stopHeartbeat()
    await poller.stop()
    session.lock.release()
  }

  if (outcome.kind === 'polling-ended') {
    terminal.error(
      outcome.exit === 'unauthorized' ? messages.pairTokenRejected : messages.pairPollingConflict,
    )
    return EXIT_FAILURE
  }
  return confirmBinding(deps, session, outcome.binding)
}

async function confirmBinding(
  deps: HubInitDeps,
  session: HubInitSession,
  binding: Pairing,
): Promise<number> {
  const { terminal, messages } = deps
  if (binding.state === 'expired') {
    terminal.error(messages.hubInitExpired)
    return EXIT_FAILURE
  }
  const group = session.bindings.groupOf(binding.id)
  if (binding.state !== 'claimed' || binding.claimant === undefined || group === undefined) {
    terminal.error(messages.hubInitCancelled)
    return EXIT_FAILURE
  }
  terminal.print(messages.hubInitClaimedBy(binding.claimant, group))

  const rights = await session.rights(group.chatId).check(group.chatId)
  if (!rights.ok) {
    terminal.error(messages.hubInitRightsUnknown(rights.detail))
    session.confirmBinding.execute({ bindingId: binding.id, accept: false })
    return EXIT_FAILURE
  }
  if (rights.missing.length > 0) {
    terminal.error(messages.hubInitMissingRights(rights.missing))
    session.confirmBinding.execute({ bindingId: binding.id, accept: false })
    return EXIT_FAILURE
  }
  if (rights.optional.length > 0) terminal.print(messages.hubInitOptionalRights(rights.optional))

  const accept = await terminal.confirm(messages.hubInitConfirmPrompt)
  const result = session.confirmBinding.execute({ bindingId: binding.id, accept })
  switch (result.outcome) {
    case 'bound':
      terminal.print(messages.hubInitBound(result.group.title))
      return EXIT_OK
    case 'declined':
      terminal.print(messages.hubInitDeclined)
      return EXIT_FAILURE
    case 'expired':
      terminal.error(messages.hubInitExpired)
      return EXIT_FAILURE
    case 'cancelled':
      terminal.error(messages.hubInitCancelled)
      return EXIT_FAILURE
  }
}

/** A running hub, as `hub run` sees it. */
export interface RunningHub {
  stop(): Promise<void>
}

export interface HubRunDeps {
  readonly terminal: Terminal
  readonly messages: Messages
  readonly group: HubGroup | undefined
  readonly configured: boolean
  readonly lock: PollerLock
  readonly start: (group: HubGroup) => RunningHub
  /** Resolves when the process is asked to stop (Ctrl+C, SIGTERM). */
  readonly untilStopped: () => Promise<void>
}

/** `hub run`: the daemon. It refuses to start while anything else polls the bot. */
export async function runHubRun(deps: HubRunDeps): Promise<number> {
  const { terminal, messages, group } = deps
  if (!deps.configured) {
    terminal.error(messages.notConfigured)
    return EXIT_FAILURE
  }
  if (group === undefined) {
    terminal.error(messages.hubRunNotConfigured)
    return EXIT_FAILURE
  }
  const probe = deps.lock.tryAcquire('hub')
  if (!probe.acquired) {
    terminal.error(messages.hubRunBusy(probe.holder.role, probe.holder.pid))
    return EXIT_FAILURE
  }
  // The hub's supervisor takes the lock again at once (same pid) and keeps it alive.
  const hub = deps.start(group)
  terminal.print(messages.hubRunStarted(group.title))
  await deps.untilStopped()
  await hub.stop()
  deps.lock.release()
  terminal.print(messages.hubRunStopped)
  return EXIT_OK
}

export interface HubStatusDeps {
  readonly terminal: Terminal
  readonly messages: Messages
  readonly hubGroup: HubGroupStore
  readonly lock: PollerLock
  readonly topicCount: (chatId: string) => number
}

export function runHubStatus(deps: HubStatusDeps): number {
  const group = deps.hubGroup.load()
  if (group === undefined) {
    deps.terminal.print(deps.messages.hubStatusOff)
    return EXIT_OK
  }
  const holder = deps.lock.currentHolder?.()
  const running = holder?.role === 'hub'
  deps.terminal.print(
    deps.messages.hubStatusOn({
      title: group.title,
      chatId: group.chatId,
      running,
      pid: running ? holder?.pid : undefined,
      topics: deps.topicCount(group.chatId),
    }),
  )
  return EXIT_OK
}

export interface HubOffDeps {
  readonly terminal: Terminal
  readonly messages: Messages
  readonly hubGroup: HubGroupStore
  readonly audit: AuditLog
  readonly clock: Clock
}

/** `hub off`: forgets the group; sessions started afterwards poll the private chat again. */
export function runHubOff(deps: HubOffDeps): number {
  const group = deps.hubGroup.load()
  if (group === undefined || !deps.hubGroup.clear()) {
    deps.terminal.print(deps.messages.hubOffNotOn)
    return EXIT_OK
  }
  deps.audit.append({
    at: deps.clock.now(),
    actor: ACTOR,
    event: 'hub.unbound',
    details: { groupId: group.chatId },
  })
  deps.terminal.print(deps.messages.hubOffDone)
  return EXIT_OK
}
