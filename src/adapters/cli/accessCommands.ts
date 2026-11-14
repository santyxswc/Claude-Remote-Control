import type { Messages } from '../../application/i18n/messages.ts'
import type { Terminal } from '../../application/ports/Terminal.ts'
import type { ListAllowedSenders } from '../../application/use-cases/ListAllowedSenders.ts'
import type { RevokeSender } from '../../application/use-cases/RevokeSender.ts'
import { isSenderId } from '../../domain/Sender.ts'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exitCodes.ts'

export interface AccessCommandDeps {
  readonly terminal: Terminal
  readonly messages: Messages
  readonly listAllowed: ListAllowedSenders
  readonly revokeSender: RevokeSender
}

/** `access list` */
export function runAccessList(deps: AccessCommandDeps): number {
  const { terminal, messages } = deps
  const senders = deps.listAllowed.execute()
  if (senders.length === 0) {
    terminal.print(messages.accessListEmpty)
    return EXIT_OK
  }
  terminal.print(messages.accessListHeader)
  for (const sender of senders) {
    terminal.print(messages.accessListRow(sender, new Date(sender.addedAt).toISOString()))
  }
  return EXIT_OK
}

/** `access revoke <id>` */
export function runAccessRevoke(deps: AccessCommandDeps, rawId: string): number {
  const { terminal, messages } = deps
  const id = rawId.trim()
  if (!isSenderId(id)) {
    terminal.error(messages.accessInvalidId)
    return EXIT_USAGE
  }
  if (!deps.revokeSender.execute(id)) {
    terminal.error(messages.accessNotFound(id))
    return EXIT_FAILURE
  }
  terminal.print(messages.accessRevoked(id))
  return EXIT_OK
}
