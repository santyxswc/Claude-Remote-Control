import { Api } from 'grammy'
import { describeTelegramError } from './redact.ts'

const PROBE_TIMEOUT_SECONDS = 15

/** What `hub init` learns about the bot's rights in the group it is about to bind. */
export type GroupRights =
  | {
      readonly ok: true
      /** Rights the hub cannot work without (topics). */
      readonly missing: readonly string[]
      /** Rights only some features need (`/pin`, F9). */
      readonly optional: readonly string[]
    }
  | { readonly ok: false; readonly detail: string }

export interface GroupRightsProbe {
  check(chatId: string): Promise<GroupRights>
}

/**
 * `getChatMember` for the bot itself (F14): creating topics needs an
 * administrator with `can_manage_topics`; pinning the status needs
 * `can_pin_messages`. Errors are described without the token.
 */
export class TelegramGroupProbe implements GroupRightsProbe {
  constructor(
    private readonly token: string,
    private readonly botId: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async check(chatId: string): Promise<GroupRights> {
    const api = new Api(this.token, {
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
    })
    try {
      const member = await api.getChatMember(Number(chatId), Number(this.botId))
      if (member.status === 'creator') return { ok: true, missing: [], optional: [] }
      if (member.status !== 'administrator') {
        return { ok: true, missing: ['administrator', 'can_manage_topics'], optional: [] }
      }
      return {
        ok: true,
        missing: member.can_manage_topics === true ? [] : ['can_manage_topics'],
        optional: member.can_pin_messages === true ? [] : ['can_pin_messages'],
      }
    } catch (error) {
      return { ok: false, detail: describeTelegramError(error, this.token).message }
    }
  }
}
