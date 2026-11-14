import type { PairingLinkBuilder } from '../../application/ports/PairingLinkBuilder.ts'

/** `https://t.me/<bot>?start=<code>`: opens the bot and sends `/start <code>`. */
export class TelegramDeepLinks implements PairingLinkBuilder {
  constructor(private readonly botUsername: string) {}

  linkFor(code: string): string {
    return `https://t.me/${encodeURIComponent(this.botUsername)}?start=${encodeURIComponent(code)}`
  }
}
