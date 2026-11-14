/**
 * Wires the inbound side of the channel: the Chain of Responsibility from
 * Telegram polling to the session, the button-tap path and the permission
 * relay, the hook listener (F4), `/shot` (F5), the `/stop` brake (F6),
 * `ask_choice` and `/skills` (F7) and incoming files (F10), under the
 * single-poller lock.
 */
import type { PermissionRequestHandler } from '../adapters/mcp/McpChannelServer.ts'
import { NoopSessionController } from '../adapters/session/NoopSessionController.ts'
import type { StateStores } from '../adapters/storage/openState.ts'
import { LOCK_HEARTBEAT_MS } from '../adapters/storage/SqlitePollerLock.ts'
import { type Every, realEvery } from '../adapters/system/every.ts'
import { Sha256SecretHasher } from '../adapters/system/Sha256SecretHasher.ts'
import { PollingSupervisor } from '../adapters/telegram/PollingSupervisor.ts'
import { TelegramPoller } from '../adapters/telegram/TelegramPoller.ts'
import { ButtonTapHandler } from '../application/callbacks/ButtonTapHandler.ts'
import { createCommandRegistry } from '../application/commands/createCommandRegistry.ts'
import { isUrgentCommand } from '../application/commands/parseCommand.ts'
import type { Messages } from '../application/i18n/messages.ts'
import { createInboundPipeline } from '../application/pipeline/createInboundPipeline.ts'
import { createSessionSteps } from '../application/pipeline/createSessionSteps.ts'
import type { InboundHandler } from '../application/pipeline/InboundStep.ts'
import type { ChannelPort } from '../application/ports/ChannelPort.ts'
import type { ChatGateway } from '../application/ports/ChatGateway.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { HookEventSource } from '../application/ports/HookEventSource.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { PermissionVerdictPort } from '../application/ports/PermissionVerdictPort.ts'
import type { PromptGateway } from '../application/ports/PromptGateway.ts'
import type { SessionController } from '../application/ports/SessionController.ts'
import type { SkillFiles } from '../application/ports/SkillFiles.ts'
import { SkillsMenu } from '../application/skills/SkillsMenu.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import type { CaptureScreenshot } from '../application/use-cases/CaptureScreenshot.ts'
import { ClaimPairing } from '../application/use-cases/ClaimPairing.ts'
import { HandleInboundMessage } from '../application/use-cases/HandleInboundMessage.ts'
import { ListSkills } from '../application/use-cases/ListSkills.ts'
import { RequestSkill } from '../application/use-cases/RequestSkill.ts'
import { type AttachmentWiring, buildAttachments, INBOX_SWEEP_MS } from './attachments.ts'
import { buildBrake } from './brake.ts'
import { buildChoices, type ChoiceWiring } from './choices.ts'
import { buildHookListener, type HookListener, type SessionTracking } from './hooks.ts'
import { buildPermissions, type PermissionWiring } from './permissions.ts'

/** While another process polls the bot, check this often whether it has finished. */
const LOCK_RETRY_MS = 30_000

/** How often open permission requests (and choices) are checked for expiry and confirmation timeouts. */
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
  /** How `/stop` interrupts the running turn; none (the brake alone) by default. */
  readonly sessionController?: SessionController
  /** `/shot` (F5), shared with the `send_screenshot` tool; without it there is no `/shot`. */
  readonly screenshots?: CaptureScreenshot
  /** Incoming photos and files (F10): the state directory for the inbox, and the size cap. */
  readonly attachments?: { readonly stateDir: string; readonly maxBytes: number }
  /** `/skills` (F7); without it there is no `/skills`. */
  readonly skillFiles?: SkillFiles
  /** Test seams. */
  readonly fetch?: typeof fetch
  readonly pollTimeoutSeconds?: number
  readonly every?: Every
  readonly session?: string
}

export interface TelegramInbound {
  readonly permissions: PermissionWiring
  /** `ask_choice` (F7), for the MCP tool. */
  readonly choices: ChoiceWiring
  stop(): Promise<void>
}

/** Starts polling (or waiting for the lock) and the upkeep timers; `stop` ends everything. */
export function startTelegramInbound(deps: TelegramInboundDeps): TelegramInbound {
  const { state, chat, messages, clock, logger } = deps
  const every = deps.every ?? realEvery
  const botUsername = state.identities.load()?.username
  let polling: PollingSupervisor | undefined
  const isPolling = () => polling?.isPolling === true
  const permissions = buildPermissions({
    state,
    outbound: chat,
    verdicts: deps.channel,
    messages,
    clock,
    logger,
    canRelay: isPolling,
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
  const choices = buildChoices({
    state,
    outbound: chat,
    forward,
    messages,
    clock,
    logger,
    session: permissions.session,
    canAsk: isPolling,
  })
  const attachments: AttachmentWiring | undefined =
    deps.attachments === undefined
      ? undefined
      : buildAttachments({
          stateDir: deps.attachments.stateDir,
          maxBytes: deps.attachments.maxBytes,
          session: permissions.session,
          token: deps.token,
          state,
          chat,
          forward,
          messages,
          clock,
          logger,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        })
  const listSkills =
    deps.skillFiles === undefined ? undefined : new ListSkills(deps.skillFiles, logger)
  const skillsMenu =
    listSkills === undefined ? undefined : new SkillsMenu(listSkills, chat, messages)
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
  const brake = buildBrake({
    state,
    permissions,
    controller: deps.sessionController ?? new NoopSessionController(),
    clock,
    logger,
  })
  const commands = createCommandRegistry({
    messages,
    botUsername,
    allowed: state.allowed,
    isSessionConnected: () => deps.channel.isConnected,
    pendingPermissions: permissions.pendingCount,
    brake: state.brake,
    stopSession: brake.stop,
    resumeSession: brake.resume,
    ...(deps.screenshots === undefined ? {} : { screenshots: deps.screenshots }),
    ...(skillsMenu === undefined ? {} : { skills: skillsMenu }),
    ...(attachments === undefined ? {} : { inboxUsage: attachments.usage }),
  })
  const authorizeSender = new AuthorizeSender(state.allowed)
  const pipeline: InboundHandler = createInboundPipeline({
    claimPairing: new ClaimPairing({
      pairings: state.pairings,
      audit: state.audit,
      hasher: new Sha256SecretHasher(),
      clock,
    }),
    authorizeSender,
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
      brake: state.brake,
      choiceAnswers: choices.answerWithText,
      ...(attachments === undefined ? {} : { attachments: attachments.receive }),
    }),
  })
  const taps = new ButtonTapHandler({
    authorize: authorizeSender,
    resolve: permissions.resolve,
    choices: choices.answer,
    ...(listSkills === undefined || skillsMenu === undefined
      ? {}
      : {
          skills: {
            menu: skillsMenu,
            // A skill tap becomes text from the owner and runs the whole chain, like typing it.
            request: new RequestSkill({
              list: listSkills,
              deliver: pipeline,
              brake: state.brake,
              clock,
            }),
          },
        }),
    prompts: chat,
    messages,
    clock,
    logger,
  })
  polling = new PollingSupervisor({
    lock: state.lock,
    poller: new TelegramPoller({
      token: deps.token,
      logger,
      isUrgent: (message) => isUrgentCommand(message.text),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.pollTimeoutSeconds === undefined
        ? {}
        : { pollTimeoutSeconds: deps.pollTimeoutSeconds }),
    }),
    handler: pipeline,
    callbackHandler: (callback) => taps.handle(callback),
    // Requests, choices and inboxes of an earlier poller can no longer be answered or read here.
    onPollingStarted: () => {
      void guarded(logger, 'expiring orphaned permission requests', () =>
        permissions.expire.expireOrphans(),
      )
      void guarded(logger, 'cancelling orphaned choices', () => choices.expire.expireOrphans())
      if (attachments !== undefined) {
        void guarded(logger, 'sweeping the inbox', async () => {
          await attachments.sweep.orphans()
          await attachments.sweep.execute()
        })
      }
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
    void guarded(logger, 'permission and choice expiry sweep', async () => {
      await permissions.expire.execute()
      await choices.expire.execute()
    }).finally(() => {
      sweeping = false
    })
  })
  const cancelInboxSweep =
    attachments === undefined
      ? () => {}
      : every(INBOX_SWEEP_MS, () => {
          void guarded(logger, 'inbox sweep', () => attachments.sweep.execute())
        })

  polling.start()
  const supervisor = polling
  return {
    permissions,
    choices,
    async stop() {
      cancelSweep()
      cancelInboxSweep()
      // Downloads in flight are cancelled and their partial files removed, never orphaned.
      await attachments?.receive.stop()
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
