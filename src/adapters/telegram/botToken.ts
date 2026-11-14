/** `<numeric bot id>:<secret>`, as issued by BotFather. */
const BOT_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{30,100}$/

/**
 * Checked before any network call, so a mistyped secret (say, a password
 * pasted by accident) is never sent to Telegram.
 */
export function isPlausibleBotToken(token: string): boolean {
  return BOT_TOKEN.test(token)
}
