import type { SenderProfile } from '../../domain/Sender.ts'
import type { BindingGroup, GroupBindingStore } from '../ports/GroupBindingStore.ts'
import type { ClaimOutcome, ClaimPairing } from './ClaimPairing.ts'

export interface ClaimGroupBindingDeps {
  readonly bindings: GroupBindingStore
  /** `ClaimPairing` over the bindings store and the renaming audit log. */
  readonly claim: Pick<ClaimPairing, 'execute'>
}

/** A matching code records the sender and the group; it binds nothing by itself. */
export class ClaimGroupBinding {
  constructor(private readonly deps: ClaimGroupBindingDeps) {}

  execute(input: {
    code: string
    sender: SenderProfile
    sentAt: number
    group: BindingGroup
  }): ClaimOutcome {
    const active = this.deps.bindings.findActive()
    const outcome = this.deps.claim.execute(input)
    if (outcome === 'claimed' && active !== undefined) {
      this.deps.bindings.setGroup(active.id, input.group)
    }
    return outcome
  }
}
