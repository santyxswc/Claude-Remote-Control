import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { AttachmentSource, RemoteFile } from '../../application/ports/AttachmentSource.ts'
import type { HubClient } from '../ipc/HubClient.ts'
import { DownloadValue } from '../ipc/hubProtocol.ts'

/** Telegram's `getFile` serves files up to 20 MB; one byte more tells the cap was hit. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024 + 1
const DOWNLOAD_TIMEOUT_MS = 150_000
const LEFTOVER_MS = 10 * 60_000

/**
 * Incoming files for a spoke (F14, F10 and F13): only the hub talks to
 * Telegram, so it downloads the file (only one that came in a message
 * routed to this session) into a private file of the shared state
 * directory, and this source streams it from there and removes it. The
 * spoke's use cases then apply their own caps and checks, unchanged.
 */
export class HubAttachmentSource implements AttachmentSource {
  constructor(
    private readonly client: Pick<HubClient, 'request'>,
    /** `<stateDir>/tmp`: the hub's file must be inside it. */
    private readonly scratchRoot: string,
  ) {}

  async open(fileId: string, signal: AbortSignal): Promise<RemoteFile> {
    const value = DownloadValue.parse(
      await this.client.request(
        { op: 'download', fileId, maxBytes: MAX_DOWNLOAD_BYTES },
        DOWNLOAD_TIMEOUT_MS,
      ),
    )
    const path = resolve(value.path)
    const inside = relative(resolve(this.scratchRoot), path)
    if (inside === '' || inside.startsWith('..') || inside.includes(`..${sep}`)) {
      throw new Error('the hub named a file outside the scratch directory')
    }
    if (signal.aborted) {
      await rm(path, { force: true })
      throw new Error('aborted')
    }
    // A caller that refuses the file without reading it still leaves nothing behind for long.
    setTimeout(() => void rm(path, { force: true }).catch(() => {}), LEFTOVER_MS).unref?.()
    return { size: value.size, chunks: chunks(path, signal) }
  }
}

async function* chunks(path: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const stream = createReadStream(path, { signal })
  try {
    for await (const chunk of stream) yield chunk as Uint8Array
  } finally {
    stream.destroy()
    await rm(path, { force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {})
  }
}
