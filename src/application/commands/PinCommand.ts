import type { PinStatusMessage } from '../use-cases/PinStatusMessage.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

/** `/pin` (F9): (re)creates the pinned status message of this chat. The message is the answer. */
export class PinCommand implements ChatCommand {
  readonly name = 'pin'

  constructor(
    readonly description: string,
    private readonly pin: Pick<PinStatusMessage, 'execute'>,
    private readonly texts: { readonly failed: string; readonly notPinned: string },
  ) {}

  async execute(context: CommandContext): Promise<void> {
    const outcome = await this.pin.execute(context.chatId)
    if (outcome === 'failed') await context.reply(this.texts.failed)
    if (outcome === 'not_pinned') await context.reply(this.texts.notPinned)
  }
}
