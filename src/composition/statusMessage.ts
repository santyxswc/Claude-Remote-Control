/**
 * Wires F9: the board fed by hooks, `/pin`, `/unpin` and the updater, on a
 * timer of its own (never in the inbound lanes, M1).
 */
import type { StateStores } from '../adapters/storage/openState.ts'
import type { Every } from '../adapters/system/every.ts'
import type { Messages } from '../application/i18n/messages.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { StatusMessageGateway } from '../application/ports/StatusMessageGateway.ts'
import type { StatusMessageStore } from '../application/ports/StatusMessageStore.ts'
import { StatusBoard } from '../application/status/StatusBoard.ts'
import { PinStatusMessage } from '../application/use-cases/PinStatusMessage.ts'
import { UnpinStatusMessage } from '../application/use-cases/UnpinStatusMessage.ts'
import { UpdateStatusMessages } from '../application/use-cases/UpdateStatusMessages.ts'

/** How often the updater renders and asks the policy whether an edit is due. */
export const STATUS_TICK_MS = 1_000

export interface StatusMessageWiringDeps {
  readonly state: Pick<StateStores, 'statusMessages' | 'allowed' | 'audit' | 'brake' | 'choices'>
  /** The decorated gateway from `buildOutbound`. */
  readonly gateway: StatusMessageGateway
  /** F14, a spoke: the status rows of its own topic instead of the per-chat table. */
  readonly store?: StatusMessageStore
  readonly session: string
  readonly pendingPermissions: () => number
  readonly project: string | undefined
  readonly canEdit: () => boolean
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
  readonly every: Every
}

export interface StatusMessageWiring {
  readonly board: StatusBoard
  readonly pin: PinStatusMessage
  readonly unpin: UnpinStatusMessage
  readonly update: UpdateStatusMessages
  /** Stops the timer and marks every status message "session ended" (best effort). */
  stop(): Promise<void>
}

export function buildStatusMessage(deps: StatusMessageWiringDeps): StatusMessageWiring {
  const { state, clock, logger } = deps
  const board = new StatusBoard({
    brake: state.brake,
    pendingPermissions: deps.pendingPermissions,
    pendingChoices: () =>
      state.choices.listOpen().filter((choice) => choice.session === deps.session).length,
    project: deps.project,
    messages: deps.messages,
    clock,
  })
  const common = {
    board,
    gateway: deps.gateway,
    store: deps.store ?? state.statusMessages,
    audit: state.audit,
    clock,
    logger,
  }
  const update = new UpdateStatusMessages({
    ...common,
    allowed: state.allowed,
    canEdit: deps.canEdit,
  })
  const cancel = deps.every(STATUS_TICK_MS, () => {
    update.tick().catch((error: unknown) => logger.error('status update failed', { error }))
  })
  return {
    board,
    pin: new PinStatusMessage(common),
    unpin: new UnpinStatusMessage(common),
    update,
    async stop() {
      cancel()
      await update.finish()
    },
  }
}
