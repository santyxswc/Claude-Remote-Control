import { ConcurrentPairingUpdateError, PairingNotFoundError } from '../errors.ts'
import { BindingAuditLog } from '../hub/groupBinding.ts'
import { commitTransition, expireIfDue } from '../pairingLifecycle.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { BindingGroup, GroupBindingStore } from '../ports/GroupBindingStore.ts'
import type { HubGroupStore } from '../ports/HubGroupStore.ts'

export interface ConfirmGroupBindingDeps {
  readonly bindings: GroupBindingStore
  readonly hubGroup: HubGroupStore
  readonly audit: AuditLog
  readonly clock: Clock
}

export type ConfirmBindingOutcome =
  | { readonly outcome: 'bound'; readonly group: BindingGroup }
  | { readonly outcome: 'declined' | 'expired' | 'cancelled' }

/** The owner's answer at the terminal; only an acceptance stores the group (hub mode on). */
export class ConfirmGroupBinding {
  constructor(private readonly deps: ConfirmGroupBindingDeps) {}

  execute(input: { bindingId: string; accept: boolean }): ConfirmBindingOutcome {
    const { bindings, clock } = this.deps
    const now = clock.now()
    const lifecycle = { pairings: bindings, audit: new BindingAuditLog(this.deps.audit) }
    const found = bindings.findById(input.bindingId)
    if (found === undefined) throw new PairingNotFoundError()
    const binding = expireIfDue(lifecycle, found, now)
    if (binding.state === 'expired') return { outcome: 'expired' }
    const group = bindings.groupOf(binding.id)
    const claimant = binding.claimant
    if (binding.state !== 'claimed' || group === undefined || claimant === undefined) {
      return { outcome: 'cancelled' }
    }
    if (!input.accept) {
      const entry = { at: now, actor: 'terminal', event: 'pairing.declined' } as const
      if (!commitTransition(lifecycle, binding.decline(now), entry)) {
        throw new ConcurrentPairingUpdateError()
      }
      return { outcome: 'declined' }
    }
    const entry = { at: now, actor: 'terminal', event: 'pairing.confirmed' } as const
    if (!commitTransition(lifecycle, binding.confirm(now), entry)) {
      throw new ConcurrentPairingUpdateError()
    }
    this.deps.hubGroup.save({
      chatId: group.chatId,
      title: group.title,
      boundBy: `telegram:${claimant.id}`,
      boundAt: now,
    })
    this.deps.audit.append({
      at: now,
      actor: 'terminal',
      event: 'hub.bound',
      details: { groupId: group.chatId, senderId: claimant.id },
    })
    return { outcome: 'bound', group }
  }
}
