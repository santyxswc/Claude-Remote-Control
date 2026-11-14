import type { ClaimantView, Messages } from '../../application/i18n/messages.ts'
import type { InboundHandler } from '../../application/pipeline/InboundStep.ts'
import type { Clock } from '../../application/ports/Clock.ts'
import type { InboundPoller, PollingExit } from '../../application/ports/InboundPoller.ts'
import type { PollerLock } from '../../application/ports/PollerLock.ts'
import type { Terminal } from '../../application/ports/Terminal.ts'
import type { AwaitPairingClaim } from '../../application/use-cases/AwaitPairingClaim.ts'
import type { ConfirmPairing } from '../../application/use-cases/ConfirmPairing.ts'
import type { StartPairing } from '../../application/use-cases/StartPairing.ts'
import type { Pairing } from '../../domain/Pairing.ts'
import type { Every } from '../system/every.ts'
import { EXIT_FAILURE, EXIT_OK } from './exitCodes.ts'

/** Everything `pair` needs once the bot is configured. */
export interface PairSession {
  readonly startPairing: StartPairing
  readonly awaitClaim: AwaitPairingClaim
  readonly confirmPairing: ConfirmPairing
  readonly lock: PollerLock
  /** A poller for this CLI process, used only when no channel process is polling. */
  readonly createPoller: () => InboundPoller
  readonly pipeline: InboundHandler
}

export interface PairCommandDeps {
  readonly terminal: Terminal
  readonly messages: Messages
  readonly clock: Clock
  readonly renderQr: (text: string) => string
  readonly every: Every
  readonly heartbeatMs: number
  /** Undefined when there is no token or bot identity yet. */
  readonly session: PairSession | undefined
}

type Waited =
  | { readonly kind: 'pairing'; readonly pairing: Pairing }
  | {
      readonly kind: 'polling-ended'
      readonly exit: PollingExit
    }

/**
 * `pair`: creates a pending pairing, shows the deep link as a QR code and
 * waits for the claim. If the channel process holds the poller lock it
 * receives the code and this command only watches the database; otherwise
 * this command polls Telegram itself while it waits. Access is granted only
 * after the owner confirms the claimant here.
 */
export async function runPair(deps: PairCommandDeps): Promise<number> {
  const { terminal, messages, session } = deps
  if (session === undefined) {
    terminal.error(messages.notConfigured)
    return EXIT_FAILURE
  }

  const lock = session.lock.tryAcquire('cli')
  if (!lock.acquired && lock.holder.role === 'cli') {
    terminal.error(messages.pairAnotherInProgress(lock.holder.pid))
    return EXIT_FAILURE
  }

  const poller = lock.acquired ? session.createPoller() : undefined
  const stopHeartbeat = lock.acquired
    ? deps.every(deps.heartbeatMs, () => session.lock.refresh())
    : () => {}
  const waiting = new AbortController()
  let pollingEnded: Promise<Waited> = new Promise(() => {})
  if (poller !== undefined) {
    pollingEnded = poller.start(session.pipeline).then((exit) => ({ kind: 'polling-ended', exit }))
  }

  let outcome: Waited
  try {
    const started = session.startPairing.execute()
    terminal.print(messages.pairScan)
    terminal.print(deps.renderQr(started.link))
    terminal.print(messages.pairLink(started.link))
    const seconds = Math.max(0, Math.round((started.expiresAt - deps.clock.now()) / 1000))
    terminal.print(messages.pairExpiresIn(seconds))
    terminal.print(poller === undefined ? messages.pairUsingChannel : messages.pairPollingHere)

    const claimed = session.awaitClaim
      .execute(started.pairingId, waiting.signal)
      .then((pairing): Waited => ({ kind: 'pairing', pairing }))
    outcome = await Promise.race([claimed, pollingEnded])
  } finally {
    // Stop listening before asking anything: nobody else can claim from now on.
    waiting.abort()
    stopHeartbeat()
    await poller?.stop()
    if (lock.acquired) session.lock.release()
  }

  if (outcome.kind === 'polling-ended') {
    terminal.error(
      outcome.exit === 'unauthorized' ? messages.pairTokenRejected : messages.pairPollingConflict,
    )
    return EXIT_FAILURE
  }
  return confirmClaim(deps, session, outcome.pairing)
}

async function confirmClaim(
  deps: PairCommandDeps,
  session: PairSession,
  pairing: Pairing,
): Promise<number> {
  const { terminal, messages } = deps
  if (pairing.state === 'expired') {
    terminal.error(messages.pairExpired)
    return EXIT_FAILURE
  }
  if (pairing.state !== 'claimed' || pairing.claimant === undefined) {
    terminal.error(messages.pairCancelled)
    return EXIT_FAILURE
  }

  const claimant: ClaimantView = pairing.claimant
  terminal.print(messages.pairClaimedBy(claimant))
  const accept = await terminal.confirm(messages.pairConfirmPrompt)
  const result = session.confirmPairing.execute({ pairingId: pairing.id, accept })
  switch (result.outcome) {
    case 'confirmed':
      terminal.print(messages.pairConfirmed(result.sender))
      return EXIT_OK
    case 'declined':
      terminal.print(messages.pairDeclined)
      return EXIT_FAILURE
    case 'expired':
      terminal.error(messages.pairExpired)
      return EXIT_FAILURE
    case 'cancelled':
      terminal.error(messages.pairCancelled)
      return EXIT_FAILURE
  }
}
