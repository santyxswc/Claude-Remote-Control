import type { CommandRegistry } from '../commands/CommandRegistry.ts'
import { parseCommand } from '../commands/parseCommand.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Logger } from '../ports/Logger.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * Step 6: runs registered commands. A `/word` that is not registered is
 * passed on and reaches Claude like any text (Claude Code skills can be
 * slash-named). So is `/cmd@other_bot` when it names a different bot.
 */
export class CommandRouterStep implements InboundStep {
  constructor(
    private readonly registry: CommandRegistry,
    private readonly chat: ChatGateway,
    private readonly logger: Logger,
    /** This bot's username, to tell `/help@this_bot` from `/help@other_bot`. */
    private readonly botUsername: string | undefined,
  ) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    const parsed = message.text === undefined ? undefined : parseCommand(message.text)
    const command = parsed === undefined ? undefined : this.registry.find(parsed.name)
    if (
      parsed === undefined ||
      command === undefined ||
      message.sender === undefined ||
      !this.#addressedToUs(parsed.mention)
    ) {
      await next(message)
      return
    }

    this.logger.info('running chat command', { command: command.name, senderId: message.sender.id })
    try {
      await command.execute({
        chatId: message.chatId,
        sender: message.sender,
        args: parsed.args,
        reply: async (text) => {
          await this.chat.sendText(message.chatId, text)
        },
      })
    } catch (error) {
      this.logger.error('chat command failed', { command: command.name, error })
    }
  }

  #addressedToUs(mention: string | undefined): boolean {
    if (mention === undefined || this.botUsername === undefined) return true
    return mention.toLowerCase() === this.botUsername.toLowerCase()
  }
}
