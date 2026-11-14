import type { PermissionRequest } from '../../domain/permissions/PermissionRequest.ts'

/**
 * Persists relayed permission requests. Writers race (a tap, the expiry
 * timer, a terminal answer), so `update` is a compare-and-set.
 */
export interface PermissionStore {
  /** Creates the request, overwriting a stored one with the same id. */
  put(request: PermissionRequest): void
  /** Stores `next` only if the stored revision is still `expectedRevision`. */
  update(next: PermissionRequest, expectedRevision: number): boolean
  findById(id: string): PermissionRequest | undefined
  /** Pending or awaiting confirmation, of every session, oldest first. */
  listOpen(): readonly PermissionRequest[]
}
