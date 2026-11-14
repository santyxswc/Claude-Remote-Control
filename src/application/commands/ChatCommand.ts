import type { SenderProfile } from '../../domain/Sender.ts'

/** What a command gets when it runs: who asked, the arguments, and a way to answer. */
export interface CommandContext {
  readonly chatId: string
  /** Always an allowlisted sender: commands run after authentication. */
  readonly sender: SenderProfile
  /** Everything after the command name, trimmed; empty when there is none. */
  readonly args: string
  /** Answers in the same chat, through the redacting outbound pipeline. */
  reply(text: string): Promise<void>
}

/**
 * GoF Command: one object per chat command. The router only knows this
 * interface, so a new command is a new class registered at composition.
 */
export interface ChatCommand {
  /** Lowercase, without the slash: `[a-z0-9_]{1,32}`, as Telegram allows. */
  readonly name: string
  /** One line for `/help`, already localized. */
  readonly description: string
  execute(context: CommandContext): Promise<void>
}
