import type { BotIdentity } from '../../domain/BotIdentity.ts'

/** Caches the bot identity so the CLI can build links without a network call. */
export interface BotIdentityStore {
  load(): BotIdentity | undefined
  save(identity: BotIdentity): void
}
