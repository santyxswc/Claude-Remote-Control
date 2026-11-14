import type { ShotProblemView } from '../i18n/messages.ts'
import type { CaptureOutcome, CaptureScreenshot } from '../use-cases/CaptureScreenshot.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

/**
 * `/shot` (the screen) and `/shot <url>` (a page). It runs before the brake
 * gate, so it also works while braked: looking is harmless. A refusal is
 * answered at once; otherwise "capturing..." right away and the capture runs
 * in the background (M1: nothing else waits for it), then the image (with its
 * caption) is the answer, or a short explanation.
 */
export class ShotCommand implements ChatCommand {
  readonly name = 'shot'

  constructor(
    readonly description: string,
    private readonly capture: Pick<CaptureScreenshot, 'start'>,
    private readonly render: (view: ShotProblemView) => string,
    private readonly capturing: string,
  ) {}

  async execute(context: CommandContext): Promise<void> {
    const start = this.capture.start({
      chatId: context.chatId,
      actor: `telegram:${context.sender.id}`,
      ...(context.args === '' ? {} : { url: context.args }),
    })
    if (!start.started) {
      await this.#explain(context, start.outcome)
      return
    }
    await context.reply(this.capturing)
    // Outcomes are audited and logged by the use case; a lost answer here is only a lost text.
    void start.done.then((outcome) => this.#explain(context, outcome)).catch(() => {})
  }

  async #explain(context: CommandContext, outcome: CaptureOutcome): Promise<void> {
    const problem = toProblem(outcome)
    if (problem !== undefined) await context.reply(this.render(problem))
  }
}

function toProblem(outcome: CaptureOutcome): ShotProblemView | undefined {
  switch (outcome.status) {
    case 'sent':
      return undefined
    case 'refused':
      return outcome.reason === 'busy' ? { problem: 'busy' } : { problem: 'failed' }
    case 'invalid_url':
      return { problem: 'invalid_url' }
    case 'unavailable':
      return {
        problem: 'unavailable',
        kind: outcome.kind,
        reason: outcome.detail?.reason,
        remedies: outcome.detail?.remedies ?? [],
      }
    case 'too_large':
      return { problem: 'too_large', megabytes: Math.ceil(outcome.bytes / 1_000_000) }
    case 'failed':
      return { problem: 'failed' }
  }
}
