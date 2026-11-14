/**
 * Wires the hub (F14, ADR 0017): the one process that owns the bot in hub
 * mode. It holds the poller lock (role `hub`), is the only `getUpdates`
 * consumer and the only sender, listens for spokes (one per Claude Code
 * session) and for hook events, and routes each topic to its session. Run by
 * `bun run bridge -- hub run`, in the CLI's composition root.
 */
import { randomBytes } from 'node:crypto'
import { createWriteStream, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { hubEndpoint } from '../adapters/ipc/endpoint.ts'
import { HubServer, type RegistrationAnswer } from '../adapters/ipc/HubServer.ts'
import { loadOrCreateHookSecret } from '../adapters/ipc/hookSecret.ts'
import type { HubRequest } from '../adapters/ipc/hubProtocol.ts'
import type { StateStores } from '../adapters/storage/openState.ts'
import { LOCK_HEARTBEAT_MS } from '../adapters/storage/SqlitePollerLock.ts'
import { PRIVATE_DIR_MODE, SECRET_FILE_MODE } from '../adapters/storage/stateDir.ts'
import { CryptoRandomSource } from '../adapters/system/CryptoRandomSource.ts'
import { type Every, realEvery } from '../adapters/system/every.ts'
import { Sha256SecretHasher } from '../adapters/system/Sha256SecretHasher.ts'
import { PollingSupervisor } from '../adapters/telegram/PollingSupervisor.ts'
import { TelegramAttachmentSource } from '../adapters/telegram/TelegramAttachmentSource.ts'
import { TelegramPoller } from '../adapters/telegram/TelegramPoller.ts'
import { isUrgentCommand } from '../application/commands/parseCommand.ts'
import { parseHookEvent } from '../application/hooks/hookEvents.ts'
import { HubPrivateChatStep } from '../application/hub/HubPrivateChatStep.ts'
import { HubRegistry, type SpokeChannel } from '../application/hub/HubRegistry.ts'
import { HubRouter } from '../application/hub/HubRouter.ts'
import { HubSessionLifecycle } from '../application/hub/HubSessionLifecycle.ts'
import { type DownloadedFile, TopicBoundGateway } from '../application/hub/TopicBoundGateway.ts'
import type { Messages } from '../application/i18n/messages.ts'
import { createInboundPipeline } from '../application/pipeline/createInboundPipeline.ts'
import { RateLimitStep } from '../application/pipeline/RateLimitStep.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { HookEventSource } from '../application/ports/HookEventSource.ts'
import type { HubGroup } from '../application/ports/HubGroupStore.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { Sleeper } from '../application/ports/Sleeper.ts'
import { AssignHubTopic } from '../application/use-cases/AssignHubTopic.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { ClaimPairing } from '../application/use-cases/ClaimPairing.ts'
import { EngageBrake } from '../application/use-cases/EngageBrake.ts'
import { ResumeSession } from '../application/use-cases/ResumeSession.ts'
import { projectKey } from '../domain/hub/projectKey.ts'
import { TokenBucket } from '../domain/TokenBucket.ts'
import { createHookIpcServer } from './hooks.ts'
import { buildOutbound } from './outbound.ts'

/** While another process polls the bot, check this often whether it has finished. */
const LOCK_RETRY_MS = 30_000
/** How often reservations of sessions that never came back are released. */
const RESERVATION_SWEEP_MS = 10_000
/** Ledger rows (which topic a prompt belongs to) are kept this long. */
const LEDGER_TTL_MS = 30 * 24 * 60 * 60_000
const LEDGER_PRUNE_MS = 60 * 60_000
/** A file download for a spoke is abandoned after this long. */
const DOWNLOAD_TIMEOUT_MS = 120_000
/** Prefix of the hub's download files in `<stateDir>/tmp`. */
const DOWNLOAD_PREFIX = 'hub-'

export interface HubDeps {
  readonly state: StateStores
  readonly stateDir: string
  readonly token: string
  readonly group: HubGroup
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
  readonly platform: NodeJS.Platform
  /** Where hook events arrive; the real listener by default. */
  readonly hooks?: HookEventSource
  /** Test seams. */
  readonly fetch?: typeof fetch
  readonly sleeper?: Sleeper
  readonly pollTimeoutSeconds?: number
  readonly every?: Every
}

export interface Hub {
  /** True while this process holds the lock and serves the group. */
  readonly isServing: boolean
  readonly registry: HubRegistry
  /** Resolves once the hub gave up polling for good (a bad token, a foreign poller). */
  stop(): Promise<void>
}

export function startHub(deps: HubDeps): Hub {
  const { state, clock, logger, messages } = deps
  const chatId = deps.group.chatId
  const every = deps.every ?? realEvery
  const outbound = buildOutbound({
    token: deps.token,
    dev: undefined,
    literalSecrets: [],
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.sleeper === undefined ? {} : { sleeper: deps.sleeper }),
  })
  const authorize = new AuthorizeSender(state.allowed)
  const limiter = new TokenBucket()
  const registry = new HubRegistry()
  const assign = new AssignHubTopic({
    chatId,
    topics: state.hubTopics,
    sessions: state.hubSessions,
    registry,
    gateway: outbound,
    clock,
    logger,
  })
  const lifecycle = new HubSessionLifecycle({
    chatId,
    registry,
    sessions: state.hubSessions,
    assign,
    chat: outbound,
    messages,
    clock,
    logger,
  })
  const brakeDeps = { brake: state.brake, audit: state.audit, clock, logger }
  const botUsername = state.identities.load()?.username
  const privateChat = createInboundPipeline({
    // `pair` keeps working in hub mode: the hub receives the `/start <code>`.
    claimPairing: new ClaimPairing({
      pairings: state.pairings,
      audit: state.audit,
      hasher: new Sha256SecretHasher(),
      clock,
    }),
    authorizeSender: authorize,
    chat: outbound,
    messages,
    logger,
    clock,
    afterAuthentication: [
      new RateLimitStep({
        limiter,
        clock,
        chat: outbound,
        audit: state.audit,
        logger,
        slowDown: messages.slowDown,
      }),
      new HubPrivateChatStep(
        (message, sender, place) => router.handleCommand(message, sender, place),
        outbound,
        messages,
        logger,
      ),
    ],
  })
  const router = new HubRouter({
    chatId,
    authorize,
    limiter,
    registry,
    ledger: state.hubMessages,
    engage: new EngageBrake(brakeDeps),
    resume: new ResumeSession(brakeDeps),
    chat: outbound,
    privateChat,
    botUsername,
    messages,
    clock,
    logger,
  })

  const scratch = join(deps.stateDir, 'tmp')
  const caseInsensitive = deps.platform === 'win32'
  const downloads = new TelegramAttachmentSource(deps.token, {
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  })
  let stopping = false

  const onRegister = async (
    registration: { session: string; projectDir: string; projectName: string | undefined },
    channel: SpokeChannel,
  ): Promise<RegistrationAnswer> => {
    if (stopping) return { ok: false, reason: 'failed' }
    const result = await lifecycle.register({
      session: registration.session,
      projectKey: projectKey(resolve(registration.projectDir), caseInsensitive),
      projectName: registration.projectName,
      channel,
    })
    if (!result.ok) return { ok: false, reason: 'failed' }
    const { live, assigned } = result
    const gateway = new TopicBoundGateway({
      chatId,
      session: live,
      outbound,
      authorize,
      ledger: state.hubMessages,
      isLocalImage: (path) => isInside(scratch, path),
      download: (fileId, maxBytes) => download(downloads, scratch, fileId, maxBytes),
      recreateTopic: async (topicId) => {
        const fresh = await assign.recreate(topicId)
        if (fresh !== undefined) state.hubSessions.upsert(live.session, fresh, clock.now())
        return fresh
      },
      clock,
    })
    return {
      ok: true,
      topicId: live.topicId,
      topicName: live.topicName,
      endedSessions: assigned.ended,
      handle: (request) => dispatch(gateway, request),
      closed: () => {
        if (stopping || !serving) lifecycle.detach(live)
        else void lifecycle.end(live, true)
      },
    }
  }

  const secret = loadOrCreateHookSecret(deps.stateDir, new CryptoRandomSource())
  const spokes = new HubServer({
    endpoint: hubEndpoint(deps.stateDir),
    secret,
    logger,
    onRegister,
  })
  const hooks = deps.hooks ?? createHookIpcServer(deps.stateDir, logger)
  const routeHook = async (payload: unknown): Promise<void> => {
    const parsed = parseHookEvent(payload)
    if (!parsed.ok) return
    const { cwd, sessionId } = parsed.event
    const live = registry.routeHook(
      cwd === undefined ? undefined : projectKey(resolve(cwd), caseInsensitive),
      sessionId,
    )
    if (live === undefined) {
      logger.info('a hook event matched no single session; dropped')
      return
    }
    live.channel.deliver({ kind: 'hook', payload })
  }

  let serving = false
  const polling = new PollingSupervisor({
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
    handler: (message) => router.handleMessage(message),
    callbackHandler: (callback) => router.handleCallback(callback),
    onPollingStarted: () => {
      serving = true
      removeLeftoverDownloads(scratch)
      lifecycle.reserveOpenSessions()
      void guarded(logger, 'listening for sessions', async () => {
        const result = await spokes.start()
        if (result !== 'listening') logger.error('the hub cannot accept sessions', { result })
      })
      void guarded(logger, 'listening for hook events', () => hooks.start(routeHook))
    },
    onPollingStopped: () => {
      serving = false
      void guarded(logger, 'closing the session listener', () => spokes.stop())
      void guarded(logger, 'closing the hook listener', () => hooks.stop())
    },
    logger,
    role: 'hub',
    heartbeatMs: LOCK_HEARTBEAT_MS,
    retryMs: LOCK_RETRY_MS,
    every,
  })
  const cancelReservations = every(RESERVATION_SWEEP_MS, () => lifecycle.sweepReservations())
  const cancelPrune = every(LEDGER_PRUNE_MS, () => {
    state.hubMessages.prune(clock.now() - LEDGER_TTL_MS)
  })
  state.hubMessages.prune(clock.now() - LEDGER_TTL_MS)
  polling.start()

  return {
    get isServing() {
      return serving
    },
    registry,
    async stop() {
      stopping = true
      cancelReservations()
      cancelPrune()
      await spokes.stop()
      await hooks.stop()
      await polling.stop()
    },
  }
}

/** One spoke request, already bound to its topic by the gateway. */
async function dispatch(gateway: TopicBoundGateway, request: HubRequest): Promise<unknown> {
  switch (request.op) {
    case 'sendText':
      return gateway.sendText(
        request.chatId,
        request.text,
        request.replyTo === undefined ? undefined : { replyTo: request.replyTo },
      )
    case 'typing':
      return gateway.sendTyping(request.chatId)
    case 'sendPrompt':
      return gateway.sendPrompt(request.chatId, request.text, request.keyboard)
    case 'editPrompt':
      return gateway.editPrompt(request.ref, request.text, request.keyboard)
    case 'answerCallback':
      return gateway.answerCallback(request.callbackId, request.text)
    case 'sendImage':
      return gateway.sendImage(request.chatId, request.image, request.caption)
    case 'sendDocument':
      return gateway.sendDocument(request.chatId, request.document, request.caption)
    case 'sendStatus':
      return gateway.sendStatus(request.chatId, request.text)
    case 'editStatus':
      return gateway.editStatus(request.ref, request.text)
    case 'pinStatus':
      return gateway.pinStatus(request.ref)
    case 'unpinStatus':
      return gateway.unpinStatus(request.ref)
    case 'download':
      return gateway.download(request.fileId, request.maxBytes)
  }
}

/** A regular file (not a link) really inside `root`, as the spokes' capture scratch writes them. */
function isInside(root: string, path: string): boolean {
  try {
    const base = realpathSync(root)
    const target = realpathSync(resolve(path))
    const inside = relative(base, target)
    return (
      inside !== '' &&
      !inside.startsWith('..') &&
      !inside.includes(`..${sep}`) &&
      lstatSync(resolve(path)).isFile()
    )
  } catch {
    return false
  }
}

/** Streams a Telegram file into a private file for the spoke, at most `maxBytes`. */
async function download(
  source: TelegramAttachmentSource,
  scratch: string,
  fileId: string,
  maxBytes: number,
): Promise<DownloadedFile> {
  mkdirSync(scratch, { recursive: true, mode: PRIVATE_DIR_MODE })
  const name = `${DOWNLOAD_PREFIX}${randomBytes(16).toString('hex')}`
  const part = join(scratch, `${name}.part`)
  const path = join(scratch, name)
  const remote = await source.open(fileId, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS))
  const out = createWriteStream(part, { mode: SECRET_FILE_MODE, flags: 'wx' })
  let written = 0
  try {
    for await (const chunk of remote.chunks) {
      const room = maxBytes - written
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk
      if (!out.write(piece)) await new Promise((done) => out.once('drain', done))
      written += piece.length
      if (written >= maxBytes) break
    }
    await new Promise<void>((done, fail) =>
      out.end((error?: Error | null) => (error ? fail(error) : done())),
    )
    await rename(part, path)
  } catch (error) {
    out.destroy()
    await rm(part, { force: true })
    throw error
  }
  return { path, size: remote.size ?? written }
}

function removeLeftoverDownloads(scratch: string): void {
  let names: string[]
  try {
    names = readdirSync(scratch)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(DOWNLOAD_PREFIX)) continue
    rmSync(join(scratch, name), { force: true })
  }
}

async function guarded(logger: Logger, what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    logger.error(`${what} failed`, { error })
  }
}
