import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'

/**
 * Which message is the pinned status of each chat (F9), so a restart keeps
 * editing the same one. One per chat.
 */
export interface StatusMessageStore {
  put(ref: PromptRef, at: number): void
  find(chatId: string): PromptRef | undefined
  list(): readonly PromptRef[]
  remove(chatId: string): void
}
