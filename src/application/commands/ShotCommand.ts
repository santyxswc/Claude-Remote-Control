import type { ShotProblemView } from '../i18n/messages.ts'
import type { CaptureOutcome, CaptureScreenshot } from '../use-cases/CaptureScreenshot.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

/**
 * `/shot` (the screen) and `/shot <url>` (a page). It runs before the brake
 * gate, so it also works while braked: looking is harmless. On success the
 * image (with its caption) is the answer; otherwise a short explanation.
 */
export class ShotCommand implements ChatCommand {
  readonly name = 'shot'

  constructor(
    readonly description: string,
    private readonly capture: Pick<CaptureScreenshot, 'execute'>,
    private readonly render: (view: ShotProblemView) => string,
  ) {}

  async execute(context: CommandContext): Promise<void> {
    const outcome = await this.capture.execute({
      chatId: context.chatId,
      actor: `telegram:${context.sender.id}`,
      ...(context.args === '' ? {} : { url: context.args }),
    })
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
