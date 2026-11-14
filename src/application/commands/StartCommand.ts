import type { ChatCommand, CommandContext } from './ChatCommand.ts'

/**
 * `/start` without a payload (the pairing step consumes `/start <code>`
 * before authentication): confirms the bridge is connected.
 */
export class StartCommand implements ChatCommand {
  readonly name = 'start'

  constructor(
    readonly description: string,
    private readonly greeting: string,
  ) {}

  async execute(context: CommandContext): Promise<void> {
    await context.reply(this.greeting)
  }
}
