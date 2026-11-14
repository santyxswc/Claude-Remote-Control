import type { Choice } from '../../domain/choices/Choice.ts'

/**
 * Persists questions asked with `ask_choice` (F7). Writers race (a tap, a
 * typed answer, the expiry timer), so `update` is a compare-and-set.
 */
export interface ChoiceStore {
  put(choice: Choice): void
  /** Stores `next` only if the stored revision is still `expectedRevision`. */
  update(next: Choice, expectedRevision: number): boolean
  findById(id: string): Choice | undefined
  /** Pending or awaiting a typed answer, of every session, oldest first. */
  listOpen(): readonly Choice[]
}
