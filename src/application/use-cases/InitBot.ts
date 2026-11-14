import type { BotIdentity } from '../../domain/BotIdentity.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { BotIdentityProbe } from '../ports/BotIdentityProbe.ts'
import type { BotIdentityStore } from '../ports/BotIdentityStore.ts'
import type { BotTokenStore } from '../ports/BotTokenStore.ts'
import type { Clock } from '../ports/Clock.ts'

export interface InitBotDeps {
  readonly probe: BotIdentityProbe
  readonly tokens: BotTokenStore
  readonly identities: BotIdentityStore
  readonly audit: AuditLog
  readonly clock: Clock
}

/**
 * Validates a bot token with the platform and only then stores it with the
 * bot identity. A rejected token is never written anywhere.
 */
export class InitBot {
  constructor(private readonly deps: InitBotDeps) {}

  async execute(token: string): Promise<BotIdentity> {
    const identity = await this.deps.probe.probe(token)
    this.deps.tokens.save(token)
    this.deps.identities.save(identity)
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: 'terminal',
      event: 'bot.initialized',
      details: { botId: identity.id, botUsername: identity.username },
    })
    return identity
  }
}
