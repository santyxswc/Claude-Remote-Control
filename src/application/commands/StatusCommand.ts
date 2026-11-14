import type { StatusView } from '../i18n/messages.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

export interface StatusCommandDeps {
  readonly description: string
  readonly render: (view: StatusView) => string
  /** From the cached `getMe`; undefined if it was never stored. */
  readonly botUsername: string | undefined
  readonly allowed: AllowedSenderStore
  /** Whether the MCP transport to Claude Code is open. */
  readonly isSessionConnected: () => boolean
}

/**
 * `/status`: only facts this process knows. It cannot know whether Claude
 * Code loaded the server as a channel or whether Claude is busy, and says so.
 */
export class StatusCommand implements ChatCommand {
  readonly name = 'status'
  readonly description: string

  constructor(private readonly deps: StatusCommandDeps) {
    this.description = deps.description
  }

  async execute(context: CommandContext): Promise<void> {
    const paired = this.deps.allowed.list().find((sender) => sender.id === context.sender.id)
    await context.reply(
      this.deps.render({
        botUsername: this.deps.botUsername,
        pairedSince: paired === undefined ? undefined : new Date(paired.addedAt).toISOString(),
        sessionConnected: this.deps.isSessionConnected(),
      }),
    )
  }
}
