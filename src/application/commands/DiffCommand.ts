import type { DiffProblemView } from '../i18n/messages.ts'
import type { DiffOutcome, ShowDiff } from '../use-cases/ShowDiff.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

/**
 * `/diff [path]` (F8). It runs before the brake gate, so it also works while
 * braked: reading the repository is harmless. Refusals (a bad path, busy)
 * are answered at once; the read runs in the background (M1), and the
 * document is the answer, or one short message.
 */
export class DiffCommand implements ChatCommand {
  readonly name = 'diff'

  constructor(
    readonly description: string,
    private readonly diff: Pick<ShowDiff, 'start'>,
    private readonly render: (view: DiffProblemView) => string,
  ) {}

  async execute(context: CommandContext): Promise<void> {
    const start = this.diff.start({
      chatId: context.chatId,
      actor: `telegram:${context.sender.id}`,
      path: context.args,
    })
    if (!start.started) {
      await this.#explain(context, start.outcome)
      return
    }
    // Outcomes are audited and logged by the use case; a lost answer here is only a lost text.
    void start.done.then((outcome) => this.#explain(context, outcome)).catch(() => {})
  }

  async #explain(context: CommandContext, outcome: DiffOutcome): Promise<void> {
    const problem = toProblem(outcome)
    if (problem !== undefined) await context.reply(this.render(problem))
  }
}

function toProblem(outcome: DiffOutcome): DiffProblemView | undefined {
  switch (outcome.status) {
    case 'sent':
      return undefined
    case 'no_changes':
      return { problem: 'no_changes', branch: outcome.branch, pathFilter: outcome.pathFilter }
    case 'invalid_path':
      return { problem: 'invalid_path', reason: outcome.problem }
    case 'refused':
      return outcome.reason === 'chat_not_allowed'
        ? { problem: 'failed' }
        : { problem: outcome.reason }
    case 'failed':
      return { problem: 'failed' }
  }
}
