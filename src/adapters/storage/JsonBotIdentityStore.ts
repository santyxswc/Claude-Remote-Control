import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { BotIdentityStore } from '../../application/ports/BotIdentityStore.ts'
import type { BotIdentity } from '../../domain/BotIdentity.ts'

export const BOT_IDENTITY_FILE = 'bot.json'

const BotIdentitySchema = z.object({ id: z.string().min(1), username: z.string().min(1) })

/** Caches `getMe` in `<stateDir>/bot.json`. Not secret; a corrupt file reads as missing. */
export class JsonBotIdentityStore implements BotIdentityStore {
  readonly #path: string

  constructor(stateDir: string) {
    this.#path = join(stateDir, BOT_IDENTITY_FILE)
  }

  load(): BotIdentity | undefined {
    if (!existsSync(this.#path)) return undefined
    try {
      const parsed = BotIdentitySchema.safeParse(JSON.parse(readFileSync(this.#path, 'utf8')))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  save(identity: BotIdentity): void {
    const data = { id: identity.id, username: identity.username }
    writeFileSync(this.#path, `${JSON.stringify(data, null, 2)}\n`)
  }
}
