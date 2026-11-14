import type { BotIdentity } from '../../domain/BotIdentity.ts'

/** Validates a token against the platform and returns the bot it belongs to. */
export interface BotIdentityProbe {
  /**
   * Rejects with `InvalidBotTokenError` when the platform refuses the token
   * and `BotUnreachableError` when it cannot be asked.
   */
  probe(token: string): Promise<BotIdentity>
}
