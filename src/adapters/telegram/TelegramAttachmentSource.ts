import { Api } from 'grammy'
import type { AttachmentSource, RemoteFile } from '../../application/ports/AttachmentSource.ts'
import { describeTelegramError, TelegramCallError } from './redact.ts'

/** A 20 MB file on a slow link; beyond this the download is abandoned. */
const DOWNLOAD_TIMEOUT_MS = 120_000

/** `getFile` paths look like `photos/file_12.jpg`; anything else is not used in a URL. */
const FILE_PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/

type ApiSignal = Parameters<Api['getFile']>[1]

export interface TelegramAttachmentSourceOptions {
  /** Replaces the network, for tests. */
  readonly fetch?: typeof fetch
  readonly apiRoot?: string
}

/**
 * Downloads files sent to the bot (F10): `getFile`, then a streamed GET of
 * `<root>/file/bot<token>/<file_path>`. That URL contains the token, so it
 * never leaves this class: it is not logged, and every error is replaced by
 * a redacted summary (`TelegramCallError`) before it is thrown.
 */
export class TelegramAttachmentSource implements AttachmentSource {
  readonly #api: Api
  readonly #token: string
  readonly #fetch: typeof fetch
  readonly #root: string

  constructor(token: string, options: TelegramAttachmentSourceOptions = {}) {
    this.#token = token
    this.#fetch = options.fetch ?? fetch
    this.#root = options.apiRoot ?? 'https://api.telegram.org'
    this.#api = new Api(token, {
      timeoutSeconds: 30,
      apiRoot: this.#root,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
  }

  async open(fileId: string, signal: AbortSignal): Promise<RemoteFile> {
    const limited = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
    const file = await this.#guard(() => this.#api.getFile(fileId, limited as unknown as ApiSignal))
    const path = file.file_path
    if (path === undefined || !FILE_PATH.test(path) || path.split('/').includes('..')) {
      throw new TelegramCallError({ name: 'InvalidFilePath', message: 'unusable file path' })
    }
    const response = await this.#guard(() =>
      this.#fetch(`${this.#root}/file/bot${this.#token}/${path}`, { signal: limited }),
    )
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {})
      throw new TelegramCallError({
        name: 'HttpError',
        code: response.status,
        message: 'the file download failed',
      })
    }
    const length = Number(response.headers.get('content-length') ?? Number.NaN)
    return {
      size: file.file_size ?? (Number.isSafeInteger(length) ? length : undefined),
      chunks: this.#chunks(response.body),
    }
  }

  async *#chunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await this.#guard(() => reader.read())
        if (done) return
        yield value
      }
    } finally {
      // Stopping early (a cap, a refusal, a cancel) closes the connection.
      await reader.cancel().catch(() => {})
    }
  }

  async #guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      throw new TelegramCallError(describeTelegramError(error, this.#token))
    }
  }
}
