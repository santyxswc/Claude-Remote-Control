import type { AuditEntry, AuditEvent, AuditLog } from '../ports/AuditLog.ts'

/**
 * `hub init` (F14) binds the bot to one forum supergroup with the F1 pairing
 * mechanics, unchanged: a 128-bit code from the CSPRNG, only its hash
 * stored, 120 s, five failed attempts cancel it, and nothing happens until
 * the owner confirms at the terminal. The pairing use cases run over the
 * `group_bindings` table; this log renames their audit events, so a binding
 * is never mistaken for an account pairing.
 */
export class BindingAuditLog implements AuditLog {
  constructor(private readonly inner: AuditLog) {}

  append(entry: AuditEntry): void {
    const event = entry.event.startsWith('pairing.')
      ? (`hub.binding_${entry.event.slice('pairing.'.length)}` as AuditEvent)
      : entry.event
    this.inner.append({ ...entry, event })
  }
}

/** Telegram's command for the code; addressed to the bot, so privacy mode delivers it. */
const BIND_COMMAND = /^\/bind(?:@(\w+))?\s+(\S+)\s*$/

/** The code of a `/bind <code>` message to this bot, if it is one. */
export function parseBindCommand(
  text: string | undefined,
  botUsername: string | undefined,
): string | undefined {
  const match = BIND_COMMAND.exec(text ?? '')
  if (match === null) return undefined
  const mention = match[1]
  if (mention !== undefined && botUsername !== undefined) {
    if (mention.toLowerCase() !== botUsername.toLowerCase()) return undefined
  }
  return match[2]
}
