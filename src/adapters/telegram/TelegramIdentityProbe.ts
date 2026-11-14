import { Api } from 'grammy'
import { BotUnreachableError, InvalidBotTokenError } from '../../application/errors.ts'
import type { BotIdentityProbe } from '../../application/ports/BotIdentityProbe.ts'
import type { BotIdentity } from '../../domain/BotIdentity.ts'
import { isPlausibleBotToken } from './botToken.ts'
import { describeTelegramError, isTokenRejection } from './redact.ts'

const PROBE_TIMEOUT_SECONDS = 15

/** `getMe`: proves the token works and tells us the bot's username. */
export class TelegramIdentityProbe implements BotIdentityProbe {
  constructor(private readonly fetchImpl?: typeof fetch) {}

  async probe(token: string): Promise<BotIdentity> {
    if (!isPlausibleBotToken(token)) throw new InvalidBotTokenError()
    const api = new Api(token, {
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
    })
    try {
      const me = await api.getMe()
      if (me.username === undefined || me.username === '')
        throw new BotUnreachableError('no username')
      return { id: String(me.id), username: me.username }
    } catch (error) {
      if (error instanceof BotUnreachableError) throw error
      if (isTokenRejection(error)) throw new InvalidBotTokenError()
      throw new BotUnreachableError(describeTelegramError(error, token).message)
    }
  }
}
