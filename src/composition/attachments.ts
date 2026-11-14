/**
 * Wires F10: the Telegram download source, this session's private inbox
 * under the state directory, the receive use case and the retention sweep.
 */
import { FileAttachmentInbox } from '../adapters/storage/FileAttachmentInbox.ts'
import type { StateStores } from '../adapters/storage/openState.ts'
import { TelegramAttachmentSource } from '../adapters/telegram/TelegramAttachmentSource.ts'
import type { Messages } from '../application/i18n/messages.ts'
import type { ChatGateway } from '../application/ports/ChatGateway.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { HandleInboundMessage } from '../application/use-cases/HandleInboundMessage.ts'
import { ReceiveAttachment } from '../application/use-cases/ReceiveAttachment.ts'
import { SweepInbox } from '../application/use-cases/SweepInbox.ts'

/** How often the inbox is swept besides startup and after each file. */
export const INBOX_SWEEP_MS = 60 * 60_000

export interface AttachmentWiringDeps {
  readonly stateDir: string
  readonly session: string
  readonly token: string
  readonly state: Pick<StateStores, 'audit'>
  /** The decorated gateway from `buildOutbound`, for refusal notices. */
  readonly chat: ChatGateway
  readonly forward: HandleInboundMessage
  readonly messages: Messages
  /** From `maxUploadBytes(TELEGRAM_BRIDGE_MAX_UPLOAD_MB)`. */
  readonly maxBytes: number
  readonly clock: Clock
  readonly logger: Logger
  /** Test seam for the downloads. */
  readonly fetch?: typeof fetch
}

export interface AttachmentWiring {
  readonly receive: ReceiveAttachment
  readonly sweep: SweepInbox
  readonly usage: () => Promise<{ readonly files: number; readonly bytes: number }>
}

export function buildAttachments(deps: AttachmentWiringDeps): AttachmentWiring {
  const { clock, logger } = deps
  const inbox = new FileAttachmentInbox(deps.stateDir, deps.session, logger)
  const sweep = new SweepInbox(inbox, clock, logger)
  const receive = new ReceiveAttachment({
    source: new TelegramAttachmentSource(deps.token, {
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    }),
    inbox,
    forward: deps.forward,
    chat: deps.chat,
    messages: deps.messages,
    maxBytes: deps.maxBytes,
    audit: deps.state.audit,
    clock,
    logger,
    afterKeep: async () => {
      await sweep.execute()
    },
  })
  return {
    receive,
    sweep,
    usage: async () => {
      const entries = await inbox.list()
      return { files: entries.length, bytes: entries.reduce((sum, e) => sum + e.bytes, 0) }
    },
  }
}
