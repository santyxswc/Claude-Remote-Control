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
  | 'brake.engaged'
  | 'brake.released'
  | 'session.stopped'
  | 'screenshot.sent'
  | 'screenshot.not_sent'
  | 'choice.asked'
  | 'choice.refused'
  | 'choice.answered'
  | 'choice.expired'
  | 'attachment.received'
  | 'attachment.refused'
  | 'git.diff_sent'
  | 'git.diff_not_sent'
  | 'git.action_requested'
  | 'status.pinned'
  | 'status.unpinned'
  | 'chart.sent'
  | 'chart.not_sent'
  | 'wrap.requested'
  | 'session.summary_saved'
  | 'session.summary_not_saved'
  | 'memory.proposed'
  | 'memory.refused'
  | 'memory.approved'
  | 'memory.rejected'
  | 'memory.write_failed'
  | 'memory.expired'

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
