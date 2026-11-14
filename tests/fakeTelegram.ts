import type { Update } from 'grammy/types'

export const TEST_TOKEN = '123456789:AAHtestTOKENdoNotUse_0123456789abcdef'

/** The JSON body of a Bot API call; only the fields the tests look at are named. */
export interface ApiPayload {
  readonly offset?: number
  readonly timeout?: number
  readonly limit?: number
  readonly chat_id?: string | number
  readonly text?: string
  readonly caption?: string
  /** Multipart uploads: `attach://<id>`, the file itself is in `uploads`. */
  readonly photo?: string
  readonly document?: string
  readonly allowed_updates?: readonly string[]
  readonly action?: string
  readonly parse_mode?: string
  readonly link_preview_options?: { readonly is_disabled?: boolean }
  readonly message_id?: number
  readonly callback_query_id?: string
  readonly reply_markup?: {
    readonly inline_keyboard?: readonly (readonly { text: string; callback_data?: string }[])[]
  }
  readonly reply_parameters?: {
    readonly message_id?: number
    readonly allow_sending_without_reply?: boolean
  }
}

export interface ApiCall {
  readonly method: string
  readonly payload: ApiPayload
}

/** A file part of a multipart/form-data call (sendPhoto, sendDocument). */
export interface ApiUpload {
  readonly method: string
  /** The form field: the id that `attach://<id>` in the payload names. */
  readonly field: string
  readonly filename: string
  readonly bytes: Uint8Array
}

type Reply =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false
      readonly error_code: number
      readonly description: string
      readonly parameters?: { readonly retry_after?: number }
    }
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
  readonly uploads: ApiUpload[] = []
  readonly urls: string[] = []
  readonly #updates: Update[] = []
  readonly #scripted = new Map<string, Reply[]>()
  #wake: (() => void) | undefined
  #nextUpdateId = 1
  #nextMessageId = 1000
  #nextCallbackId = 1

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    this.urls.push(url)
    const method = url.slice(url.lastIndexOf('/') + 1)
    const payload =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as ApiPayload)
        : init?.body == null
          ? {}
          : await this.#multipart(method, init)
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

  /**
   * Queues a tap on an inline button of `messageId` in `from`'s private chat
   * (or in `chat`, to play a tap from a group). Returns the callback query id.
   */
  tap(
    from: { id: number; username?: string; first_name: string },
    messageId: number,
    data: string,
    chat: { id: number; type: string } = { id: from.id, type: 'private' },
  ): string {
    const id = `cbq-${this.#nextCallbackId++}`
    this.push({
      callback_query: {
        id,
        from: { is_bot: false, ...from },
        chat_instance: 'ci',
        data,
        message: { message_id: messageId, date: 1_700_000_000, chat: { ...chat, first_name: 'x' } },
      },
    } as unknown as Omit<Update, 'update_id'>)
    return id
  }

  push(update: Omit<Update, 'update_id'>): number {
    const update_id = this.#nextUpdateId++
    this.#updates.push({ update_id, ...update } as Update)
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
    return update_id
  }

  /**
   * True while a `getUpdates` is parked with nothing new to return: every
   * update pushed so far has been handed out and the poller asked again,
   * which it only does after handling the previous batch.
   */
  get idle(): boolean {
    return this.#wake !== undefined
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
            message_id: this.#nextMessageId++,
            date: 0,
            chat: { id: payload.chat_id, type: 'private' },
            text: payload.text,
          },
        }
      case 'sendPhoto':
      case 'sendDocument':
        return {
          ok: true,
          result: {
            message_id: this.#nextMessageId++,
            date: 0,
            chat: { id: payload.chat_id, type: 'private' },
            caption: payload.caption,
          },
        }
      case 'sendChatAction':
      case 'answerCallbackQuery':
        return { ok: true, result: true }
      case 'editMessageText':
        return {
          ok: true,
          result: {
            message_id: payload.message_id,
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

  /**
   * grammY streams uploads as multipart/form-data: plain fields become the
   * payload (`chat_id` stays a string), file parts go to `uploads`.
   */
  async #multipart(method: string, init: RequestInit): Promise<ApiPayload> {
    const chunks: Uint8Array[] = []
    for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk)
    const contentType = new Headers(init.headers).get('content-type') ?? ''
    const form = await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': contentType },
    }).formData()
    const payload: Record<string, string> = {}
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        payload[key] = value
      } else {
        const file = value as File
        this.uploads.push({
          method,
          field: key,
          filename: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })
      }
    }
    return payload
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
