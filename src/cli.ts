#!/usr/bin/env bun
import { ConsoleTerminal } from './adapters/cli/ConsoleTerminal.ts'
import type { HubInitSession } from './adapters/cli/hubCommands.ts'
import type { PairSession } from './adapters/cli/pairCommand.ts'
import { renderQr } from './adapters/cli/qr.ts'
import { runCli } from './adapters/cli/runCli.ts'
import { RedactingLogger } from './adapters/logging/RedactingLogger.ts'
import { StderrLogger } from './adapters/logging/StderrLogger.ts'
import { openState, type StateStores } from './adapters/storage/openState.ts'
import { LOCK_HEARTBEAT_MS } from './adapters/storage/SqlitePollerLock.ts'
import { defaultStateDir } from './adapters/storage/stateDir.ts'
import { CryptoRandomSource } from './adapters/system/CryptoRandomSource.ts'
import { realEvery } from './adapters/system/every.ts'
import { Sha256SecretHasher } from './adapters/system/Sha256SecretHasher.ts'
import { SystemClock } from './adapters/system/SystemClock.ts'
import { TimerSleeper } from './adapters/system/TimerSleeper.ts'
import { TelegramDeepLinks } from './adapters/telegram/TelegramDeepLinks.ts'
import { TelegramGroupProbe } from './adapters/telegram/TelegramGroupProbe.ts'
import { TelegramIdentityProbe } from './adapters/telegram/TelegramIdentityProbe.ts'
import { TelegramPoller } from './adapters/telegram/TelegramPoller.ts'
import { GroupBindingClaimHandler } from './application/hub/GroupBindingClaimHandler.ts'
import { BindingAuditLog } from './application/hub/groupBinding.ts'
import { LOCALE_ENV, messagesFor, parseLocale } from './application/i18n/messages.ts'
import { createInboundPipeline } from './application/pipeline/createInboundPipeline.ts'
import { AuthorizeSender } from './application/use-cases/AuthorizeSender.ts'
import { AwaitPairingClaim } from './application/use-cases/AwaitPairingClaim.ts'
import { ClaimGroupBinding } from './application/use-cases/ClaimGroupBinding.ts'
import { ClaimPairing } from './application/use-cases/ClaimPairing.ts'
import { ConfirmGroupBinding } from './application/use-cases/ConfirmGroupBinding.ts'
import { ConfirmPairing } from './application/use-cases/ConfirmPairing.ts'
import { EngageBrake } from './application/use-cases/EngageBrake.ts'
import { InitBot } from './application/use-cases/InitBot.ts'
import { ListAllowedSenders } from './application/use-cases/ListAllowedSenders.ts'
import { ResumeSession } from './application/use-cases/ResumeSession.ts'
import { RevokeSender } from './application/use-cases/RevokeSender.ts'
import { StartPairing } from './application/use-cases/StartPairing.ts'
import { startHub } from './composition/hub.ts'
import { buildOutbound } from './composition/outbound.ts'

/**
 * Composition root of the `telegram-bridge` CLI (`init`, `pair`, `access`,
 * `stop`, `resume`, `hub`). `hub run` keeps running as the hub daemon (F14).
 * Unlike `main.ts` this process owns its terminal, so it prints to stdout.
 */

const env = process.env
const terminal = new ConsoleTerminal()
const messages = messagesFor(parseLocale(env[LOCALE_ENV]))
const clock = new SystemClock()
const hasher = new Sha256SecretHasher()

let state: StateStores | undefined
const openStores = (): StateStores => {
  state ??= openState(defaultStateDir(), env, clock)
  return state
}

function pairSession(stores: StateStores): PairSession | undefined {
  const token = stores.tokens.load()
  const identity = stores.identities.load()
  if (token === undefined || identity === undefined) return undefined
  const logger = new RedactingLogger(new StderrLogger(), [token])
  const lifecycle = { pairings: stores.pairings, audit: stores.audit }
  return {
    startPairing: new StartPairing({
      ...lifecycle,
      random: new CryptoRandomSource(),
      hasher,
      clock,
      links: new TelegramDeepLinks(identity.username),
    }),
    awaitClaim: new AwaitPairingClaim({ ...lifecycle, clock, sleeper: new TimerSleeper() }),
    confirmPairing: new ConfirmPairing({ ...lifecycle, allowed: stores.allowed, clock }),
    lock: stores.lock,
    createPoller: () => new TelegramPoller({ token, logger }),
    pipeline: createInboundPipeline({
      claimPairing: new ClaimPairing({ ...lifecycle, hasher, clock }),
      authorizeSender: new AuthorizeSender(stores.allowed),
      // Only the pairing acknowledgement is sent here, still through the redacting pipeline.
      chat: buildOutbound({ token, dev: undefined, literalSecrets: [] }),
      messages,
      logger,
      clock,
    }),
  }
}

/** F14: `hub init` once the bot is configured; the binding code is a `/bind@bot <code>` command. */
function hubInitSession(stores: StateStores): HubInitSession | undefined {
  const token = stores.tokens.load()
  const identity = stores.identities.load()
  if (token === undefined || identity === undefined) return undefined
  const logger = new RedactingLogger(new StderrLogger(), [token])
  const lifecycle = { pairings: stores.groupBindings, audit: new BindingAuditLog(stores.audit) }
  const authorize = new AuthorizeSender(stores.allowed)
  const claim = new ClaimGroupBinding({
    bindings: stores.groupBindings,
    claim: new ClaimPairing({ ...lifecycle, hasher, clock }),
  })
  return {
    botUsername: identity.username,
    hasOwner: stores.allowed.list().length > 0,
    startBinding: new StartPairing({
      ...lifecycle,
      random: new CryptoRandomSource(),
      hasher,
      clock,
      links: { linkFor: (code) => `/bind@${identity.username} ${code}` },
    }),
    awaitClaim: new AwaitPairingClaim({ ...lifecycle, clock, sleeper: new TimerSleeper() }),
    confirmBinding: new ConfirmGroupBinding({
      bindings: stores.groupBindings,
      hubGroup: stores.hubGroup,
      audit: stores.audit,
      clock,
    }),
    bindings: stores.groupBindings,
    lock: stores.lock,
    createPoller: () => new TelegramPoller({ token, logger }),
    handler: (message) =>
      new GroupBindingClaimHandler({
        claim,
        authorize,
        // Only the short acknowledgements in the group, still through the redacting pipeline.
        chat: buildOutbound({ token, dev: undefined, literalSecrets: [] }),
        messages,
        logger,
        botUsername: identity.username,
      }).handle(message),
    rights: () => new TelegramGroupProbe(token, identity.id),
  }
}

/** Ctrl+C or a service manager's SIGTERM. */
function untilStopped(): Promise<void> {
  return new Promise((done) => {
    process.once('SIGINT', () => done())
    process.once('SIGTERM', () => done())
  })
}

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    terminal,
    messages,
    init: () => {
      const stores = openStores()
      return {
        terminal,
        messages,
        tokenOverriddenByEnv: stores.tokens.overriddenByEnv,
        initBot: new InitBot({
          probe: new TelegramIdentityProbe(),
          tokens: stores.tokens,
          identities: stores.identities,
          audit: stores.audit,
          clock,
        }),
      }
    },
    pair: () => ({
      terminal,
      messages,
      clock,
      renderQr,
      every: realEvery,
      heartbeatMs: LOCK_HEARTBEAT_MS,
      session: pairSession(openStores()),
    }),
    access: () => {
      const stores = openStores()
      return {
        terminal,
        messages,
        listAllowed: new ListAllowedSenders(stores.allowed),
        revokeSender: new RevokeSender({ allowed: stores.allowed, audit: stores.audit, clock }),
      }
    },
    brake: () => {
      const stores = openStores()
      // The terminal gets the outcome from `messages`; the audit row is the record.
      const quiet = { info() {}, warn() {}, error() {} }
      const deps = { brake: stores.brake, audit: stores.audit, clock, logger: quiet }
      return {
        terminal,
        messages,
        engage: new EngageBrake(deps),
        resume: new ResumeSession(deps),
      }
    },
    hubInit: () => ({
      terminal,
      messages,
      clock,
      every: realEvery,
      heartbeatMs: LOCK_HEARTBEAT_MS,
      session: hubInitSession(openStores()),
    }),
    hubRun: () => {
      const stores = openStores()
      const token = stores.tokens.load()
      return {
        terminal,
        messages,
        group: stores.hubGroup.load(),
        configured: token !== undefined && stores.identities.load() !== undefined,
        lock: stores.lock,
        start: (group) =>
          startHub({
            state: stores,
            stateDir: defaultStateDir(),
            token: token ?? '',
            group,
            messages,
            clock,
            logger: new RedactingLogger(new StderrLogger(), token === undefined ? [] : [token]),
            platform: process.platform,
          }),
        untilStopped,
      }
    },
    hubStatus: () => {
      const stores = openStores()
      return {
        terminal,
        messages,
        hubGroup: stores.hubGroup,
        lock: stores.lock,
        topicCount: (chatId) => stores.hubTopics.listAll(chatId).length,
      }
    },
    hubOff: () => {
      const stores = openStores()
      return { terminal, messages, hubGroup: stores.hubGroup, audit: stores.audit, clock }
    },
  })
} finally {
  state?.db.close()
}
