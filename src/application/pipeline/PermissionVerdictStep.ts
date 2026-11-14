import { isPermissionRequestId } from '../../domain/permissions/PermissionRequest.ts'
import type { Messages } from '../i18n/messages.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Logger } from '../ports/Logger.ts'
import type { ResolvePermission } from '../use-cases/ResolvePermission.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * The text form from the channels reference ("yes abcde" / "no abcde"),
 * plus Spanish "si"/"sí". `/i` tolerates phone autocorrect; the id is
 * lowercased and checked again, since `/i` also lets an `L` through.
 */
const TEXT_VERDICT = /^\s*(y|yes|n|no|si|sí)\s+([a-km-z]{5})\s*$/i

/**
 * Permission verdict typed as text, for when buttons are not usable. It
 * runs after authentication and the rate limit, before commands. Text that
 * merely looks like a verdict ("no puedo") but names no request of this
 * session goes on to Claude as a normal message.
 */
export class PermissionVerdictStep implements InboundStep {
  constructor(
    private readonly resolve: ResolvePermission,
    private readonly chat: ChatGateway,
    private readonly messages: Messages,
    private readonly logger: Logger,
  ) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    const match = TEXT_VERDICT.exec(message.text ?? '')
    const word = match?.[1]?.toLowerCase()
    const requestId = match?.[2]?.toLowerCase()
    const sender = message.sender
    if (
      word === undefined ||
      requestId === undefined ||
      sender === undefined ||
      !isPermissionRequestId(requestId)
    ) {
      await next(message)
      return
    }

    const action = word.startsWith('y') || word.startsWith('s') ? 'approve' : 'deny'
    const outcome = await this.resolve.execute({ requestId, action, sender, via: 'text' })
    if (outcome === 'not_found') {
      await next(message)
      return
    }
    try {
      await this.chat.sendText(message.chatId, this.messages.permissionFeedback(outcome))
    } catch (error) {
      this.logger.warn('could not acknowledge a text verdict', { error })
    }
  }
}
