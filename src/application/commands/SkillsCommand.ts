import type { SkillsMenu } from '../skills/SkillsMenu.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

/** `/skills` (F7): the session's skills as buttons; a tap asks Claude to use one. */
export class SkillsCommand implements ChatCommand {
  readonly name = 'skills'

  constructor(
    readonly description: string,
    private readonly menu: Pick<SkillsMenu, 'send'>,
  ) {}

  async execute(context: CommandContext): Promise<void> {
    await this.menu.send(context.chatId, context.reply)
  }
}
