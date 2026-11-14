#!/usr/bin/env bun
import { ConsoleTerminal } from './adapters/cli/ConsoleTerminal.ts'
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
import { TelegramChatGateway } from './adapters/telegram/TelegramChatGateway.ts'
import { TelegramDeepLinks } from './adapters/telegram/TelegramDeepLinks.ts'
import { TelegramIdentityProbe } from './adapters/telegram/TelegramIdentityProbe.ts'
import { TelegramPoller } from './adapters/telegram/TelegramPoller.ts'
import { LOCALE_ENV, messagesFor, parseLocale } from './application/i18n/messages.ts'
import { createInboundPipeline } from './application/pipeline/createInboundPipeline.ts'
import { AuthorizeSender } from './application/use-cases/AuthorizeSender.ts'
import { AwaitPairingClaim } from './application/use-cases/AwaitPairingClaim.ts'
import { ClaimPairing } from './application/use-cases/ClaimPairing.ts'
import { ConfirmPairing } from './application/use-cases/ConfirmPairing.ts'
import { InitBot } from './application/use-cases/InitBot.ts'
import { ListAllowedSenders } from './application/use-cases/ListAllowedSenders.ts'
import { RevokeSender } from './application/use-cases/RevokeSender.ts'
import { StartPairing } from './application/use-cases/StartPairing.ts'

/**
 * Composition root of the `telegram-bridge` CLI (`init`, `pair`, `access`).
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
      chat: new TelegramChatGateway(token),
      messages,
      logger,
    }),
  }
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
  })
} finally {
  state?.db.close()
}
