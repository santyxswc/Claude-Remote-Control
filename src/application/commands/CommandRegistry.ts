import type { ChatCommand } from './ChatCommand.ts'

const COMMAND_NAME = /^[a-z0-9_]{1,32}$/

export class InvalidCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCommandError'
  }
}

/** The registered commands, in registration order (which is also `/help` order). */
export class CommandRegistry {
  readonly #commands = new Map<string, ChatCommand>()

  register(command: ChatCommand): this {
    if (!COMMAND_NAME.test(command.name)) {
      throw new InvalidCommandError(`Invalid command name: ${command.name}`)
    }
    if (this.#commands.has(command.name)) {
      throw new InvalidCommandError(`Command already registered: ${command.name}`)
    }
    this.#commands.set(command.name, command)
    return this
  }

  /** Case-insensitive, as Telegram clients may capitalize the first letter. */
  find(name: string): ChatCommand | undefined {
    return this.#commands.get(name.toLowerCase())
  }

  list(): readonly ChatCommand[] {
    return [...this.#commands.values()]
  }
}
