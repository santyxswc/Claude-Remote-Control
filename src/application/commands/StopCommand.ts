import type { StopReportView } from '../i18n/messages.ts'
import type { StopSession } from '../use-cases/StopSession.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

/** `/stop [reason]`: the panic button. */
export class StopCommand implements ChatCommand {
  readonly name = 'stop'

  constructor(
    readonly description: string,
    private readonly stop: StopSession,
    private readonly render: (view: StopReportView) => string,
  ) {}

  async execute(context: CommandContext): Promise<void> {
    const report = await this.stop.execute({
      sender: context.sender,
      ...(context.args === '' ? {} : { reason: context.args }),
    })
    await context.reply(
      this.render({
        brake: report.brake,
        since:
          report.record === undefined ? undefined : new Date(report.record.engagedAt).toISOString(),
        denied: report.denied,
        interrupt: report.interrupt,
      }),
    )
  }
}
