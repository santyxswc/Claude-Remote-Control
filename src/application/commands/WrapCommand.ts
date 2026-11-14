import type { RequestSessionWrap } from '../use-cases/RequestSessionWrap.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

/**
 * `/wrap` (F12): asks Claude to summarize the session and propose lines for
 * `CLAUDE.md`. While braked it sends nothing and says so.
 */
export class WrapCommand implements ChatCommand {
  readonly name = 'wrap'

  constructor(
    readonly description: string,
    private readonly wrap: Pick<RequestSessionWrap, 'execute'>,
    private readonly answers: { readonly sent: string; readonly braked: string },
  ) {}

  async execute(context: CommandContext): Promise<void> {
    const outcome = await this.wrap.execute({ chatId: context.chatId, sender: context.sender })
    await context.reply(outcome === 'sent' ? this.answers.sent : this.answers.braked)
  }
}
