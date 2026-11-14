import type { CommandHelp } from '../i18n/messages.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'
import type { CommandRegistry } from './CommandRegistry.ts'

/** `/help`: lists whatever is registered, so new commands show up without touching it. */
export class HelpCommand implements ChatCommand {
  readonly name = 'help'

  constructor(
    readonly description: string,
    private readonly registry: CommandRegistry,
    private readonly render: (commands: readonly CommandHelp[]) => string,
  ) {}

  async execute(context: CommandContext): Promise<void> {
    const commands = this.registry
      .list()
      .map((command) => ({ name: command.name, description: command.description }))
    await context.reply(this.render(commands))
  }
}
