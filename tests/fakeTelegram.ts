import type { Update } from 'grammy/types'

export const TEST_TOKEN = '123456789:AAHtestTOKENdoNotUse_0123456789abcdef'

/** The JSON body of a Bot API call; only the fields the tests look at are named. */
export interface ApiPayload {
  readonly offset?: number
  readonly timeout?: number
  readonly limit?: number
  readonly chat_id?: string | number
  readonly text?: string
  readonly allowed_updates?: readonly string[]
}

export interface ApiCall {
  readonly method: string
  readonly payload: ApiPayload
}

type Reply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error_code: number; readonly description: string }
  | { readonly networkError: string }

const BOT_INFO = {
  id: 123456789,
  is_bot: true,
  first_name: 'Test Bot',
  username: 'test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
}

/**
 * An in-process stand-in for the Telegram Bot API, plugged into grammY via
 * its `fetch` client option. Nothing ever touches the network: any method it
 * does not know fails the test loudly. `getUpdates` long-polls like the real
 * one: it waits until updates are queued or the request is aborted.
 */
export class FakeTelegramApi {
  readonly calls: ApiCall[] = []
  readonly urls: string[] = []
  readonly #updates: Update[] = []
  readonly #scripted = new Map<string, Reply[]>()
  #wake: (() => void) | undefined
  #nextUpdateId = 1

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    this.urls.push(url)
    const method = url.slice(url.lastIndexOf('/') + 1)
    const payload = typeof init?.body === 'string' ? (JSON.parse(init.body) as ApiPayload) : {}
    this.calls.push({ method, payload })
    const reply = await this.#reply(method, payload, init?.signal ?? undefined)
    if ('networkError' in reply) throw new Error(reply.networkError)
    return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch

  /** The next calls to `method` get these replies, in order, before the defaults. */
  script(method: string, ...replies: Reply[]): void {
    this.#scripted.set(method, [...(this.#scripted.get(method) ?? []), ...replies])
  }

  /** Queues a private text message from `from` and wakes a pending `getUpdates`. */
  sendText(from: { id: number; username?: string; first_name: string }, text: string): number {
    return this.push({
      message: {
        message_id: this.#nextUpdateId,
        date: 1_700_000_000,
        chat: { id: from.id, type: 'private', first_name: from.first_name },
        from: { is_bot: false, ...from },
        text,
      },
    } as Omit<Update, 'update_id'>)
  }

  push(update: Omit<Update, 'update_id'>): number {
    const update_id = this.#nextUpdateId++
    this.#updates.push({ update_id, ...update } as Update)
    this.#wake?.()
    return update_id
  }

  callsTo(method: string): ApiCall[] {
    return this.calls.filter((call) => call.method === method)
  }

  /** Resolves once `getUpdates` has been called `count` times. */
  async waitForPolls(count: number): Promise<void> {
    for (let i = 0; i < 500 && this.callsTo('getUpdates').length < count; i++) {
      await Bun.sleep(2)
    }
    if (this.callsTo('getUpdates').length < count) throw new Error('getUpdates was not called')
  }

  async #reply(
    method: string,
    payload: ApiPayload,
    signal: AbortSignal | undefined,
  ): Promise<Reply> {
    const scripted = this.#scripted.get(method)?.shift()
    if (scripted !== undefined) return scripted
    switch (method) {
      case 'getMe':
        return { ok: true, result: BOT_INFO }
      case 'sendMessage':
        return {
          ok: true,
          result: {
            message_id: 1,
            date: 0,
            chat: { id: payload.chat_id, type: 'private' },
            text: payload.text,
          },
        }
      case 'getUpdates':
        return { ok: true, result: await this.#takeUpdates(payload, signal) }
      default:
        throw new Error(`FakeTelegramApi: unexpected method ${method}`)
    }
  }

  async #takeUpdates(payload: ApiPayload, signal: AbortSignal | undefined): Promise<Update[]> {
    const offset = typeof payload.offset === 'number' ? payload.offset : 0
    // Like Telegram: an offset confirms (drops) every earlier update.
    while (this.#updates.length > 0 && (this.#updates[0]?.update_id ?? 0) < offset)
      this.#updates.shift()
    if (this.#updates.length > 0 || payload.timeout === 0) return [...this.#updates]
    await new Promise<void>((resolve, reject) => {
      this.#wake = resolve
      signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
    this.#wake = undefined
    return [...this.#updates]
  }
}

/** Telegram user ids as the API sends them: JSON numbers, here above 32 bits. */
export const PHONE_OWNER = { id: 5_000_000_001, username: 'owner', first_name: 'Owner' }
export const STRANGER = { id: 6_000_000_002, username: 'stranger', first_name: 'Stranger' }
