import type { UnpinStatusMessage } from '../use-cases/UnpinStatusMessage.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

/** `/unpin` (F9): unpins the status message of this chat and stops updating it. */
export class UnpinCommand implements ChatCommand {
  readonly name = 'unpin'

  constructor(
    readonly description: string,
    private readonly unpin: Pick<UnpinStatusMessage, 'execute'>,
    private readonly texts: { readonly done: string; readonly nothing: string },
  ) {}

  async execute(context: CommandContext): Promise<void> {
    const removed = await this.unpin.execute(context.chatId)
    await context.reply(removed ? this.texts.done : this.texts.nothing)
  }
}
