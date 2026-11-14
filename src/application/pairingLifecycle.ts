import type { Pairing } from '../domain/Pairing.ts'
import type { AuditEvent, AuditLog } from './ports/AuditLog.ts'
import type { PairingStore } from './ports/PairingStore.ts'

/** Shared by the pairing use cases: every persisted transition is audited. */
export interface PairingLifecycleDeps {
  readonly pairings: PairingStore
  readonly audit: AuditLog
}

/**
 * Stores a transition (compare-and-set) and audits it. Returns false, and
 * audits nothing, when another process changed the pairing first.
 */
export function commitTransition(
  deps: PairingLifecycleDeps,
  next: Pairing,
  entry: {
    at: number
    actor: string
    event: AuditEvent
    details?: Record<string, string | number>
  },
): boolean {
  if (!deps.pairings.update(next)) return false
  deps.audit.append({
    at: entry.at,
    actor: entry.actor,
    event: entry.event,
    details: { pairingId: next.id, ...entry.details },
  })
  return true
}

/** Expires the pairing when its window has passed; returns the current version. */
export function expireIfDue(deps: PairingLifecycleDeps, pairing: Pairing, now: number): Pairing {
  if (!pairing.isDue(now)) return pairing
  const expired = pairing.expire(now)
  if (commitTransition(deps, expired, { at: now, actor: 'system', event: 'pairing.expired' })) {
    return expired
  }
  return deps.pairings.findById(pairing.id) ?? expired
}
