/** Where the bot token lives. Implementations must never log or echo it. */
export interface BotTokenStore {
  load(): string | undefined
  save(token: string): void
}
