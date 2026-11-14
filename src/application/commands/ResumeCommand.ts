import type { ResumeSession } from '../use-cases/ResumeSession.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

/** `/resume`: releases the `/stop` brake. */
export class ResumeCommand implements ChatCommand {
  readonly name = 'resume'

  constructor(
    readonly description: string,
    private readonly resume: ResumeSession,
    private readonly replies: { readonly released: string; readonly notEngaged: string },
  ) {}

  async execute(context: CommandContext): Promise<void> {
    const outcome = this.resume.execute(`telegram:${context.sender.id}`)
    await context.reply(outcome === 'released' ? this.replies.released : this.replies.notEngaged)
  }
}
