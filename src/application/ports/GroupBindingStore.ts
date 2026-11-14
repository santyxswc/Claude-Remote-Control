import type { PairingStore } from './PairingStore.ts'

/** The group a binding code was sent from (F14): the platform's claims, sanitized. */
export interface BindingGroup {
  readonly chatId: string
  readonly title: string
}

/**
 * Group bindings (`hub init`) reuse the pairing state machine (128-bit code,
 * hash only, expiry, attempt cap, terminal confirmation) in a table of their
 * own, plus the group the code came from.
 */
export interface GroupBindingStore extends PairingStore {
  setGroup(bindingId: string, group: BindingGroup): void
  groupOf(bindingId: string): BindingGroup | undefined
}
