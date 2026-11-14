export interface ParsedCommand {
  /** As typed, without the slash. */
  readonly name: string
  /** The bot named in `/cmd@bot`, if any. */
  readonly mention: string | undefined
  /** Everything after the command, trimmed. */
  readonly args: string
}

/** `/name`, `/name@bot_name`, then optional whitespace-separated arguments (may span lines). */
const COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?=\s|$)([\s\S]*)$/

/** Returns undefined for anything that is not shaped like a bot command. */
export function parseCommand(text: string): ParsedCommand | undefined {
  const match = COMMAND.exec(text)
  if (match === null) return undefined
  return { name: match[1] ?? '', mention: match[2], args: (match[3] ?? '').trim() }
}
