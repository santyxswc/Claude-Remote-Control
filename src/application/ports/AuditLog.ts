export type AuditEvent =
  | 'bot.initialized'
  | 'pairing.started'
  | 'pairing.replaced'
  | 'pairing.claimed'
  | 'pairing.attempt_failed'
  | 'pairing.cancelled'
  | 'pairing.expired'
  | 'pairing.confirmed'
  | 'pairing.declined'
  | 'sender.allowed'
  | 'sender.revoked'
  | 'message.forwarded'
  | 'message.rate_limited'
  | 'reply.sent'
  | 'reply.refused'
  | 'reply.failed'
  | 'permission.relayed'
  | 'permission.confirmation_requested'
  | 'permission.approved'
  | 'permission.denied'
  | 'permission.verdict_failed'
  | 'permission.expired'
  | 'permission.resolved_locally'
  | 'notice.sent'

/** Values that are safe to persist: never tokens, codes or message text. */
export type AuditDetails = Readonly<Record<string, string | number | boolean | null>>

export interface AuditEntry {
  /** Epoch milliseconds. */
  readonly at: number
  /** Who caused it: `terminal`, `system`, `session` (Claude) or `telegram:<sender id>`. */
  readonly actor: string
  readonly event: AuditEvent
  readonly details: AuditDetails
}

/** Append-only record of every security-relevant state change. */
export interface AuditLog {
  append(entry: AuditEntry): void
}
