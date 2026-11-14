import type { StateStores } from '../adapters/storage/openState.ts'
import type { AllowedSenderStore } from '../application/ports/AllowedSenderStore.ts'
import type { AuditLog } from '../application/ports/AuditLog.ts'
import type { ChatGateway } from '../application/ports/ChatGateway.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { Logger } from '../application/ports/Logger.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { SendReply } from '../application/use-cases/SendReply.ts'

/** Without a state directory nobody is allowlisted, so Telegram replies are always refused. */
const NOBODY: AllowedSenderStore = {
  add() {},
  remove: () => false,
  has: () => false,
  list: () => [],
}

const NO_AUDIT: AuditLog = { append() {} }

export interface ReplyWiring {
  /** Undefined when the state directory could not be opened. */
  readonly state: StateStores | undefined
  /** The decorated gateway from `buildOutbound`. */
  readonly chat: ChatGateway
  /** Chats outside the allowlist that may be answered (the dev listener's). */
  readonly extraChatIds: readonly string[]
  readonly clock: Clock
  readonly logger: Logger
  /** Observer of delivered replies (F4's notice debounce). */
  readonly onSent?: () => void
}

/** The `reply` tool's use case: the target chat is checked against the live allowlist. */
export function buildSendReply(wiring: ReplyWiring): SendReply {
  return new SendReply({
    chat: wiring.chat,
    authorize: new AuthorizeSender(wiring.state?.allowed ?? NOBODY),
    extraChatIds: new Set(wiring.extraChatIds),
    audit: wiring.state?.audit ?? NO_AUDIT,
    clock: wiring.clock,
    logger: wiring.logger,
    ...(wiring.onSent === undefined ? {} : { onSent: wiring.onSent }),
  })
}
