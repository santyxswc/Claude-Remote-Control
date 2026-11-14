import type { StatusView } from '../i18n/messages.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { ChatCommand, CommandContext } from './ChatCommand.ts'

export interface StatusCommandDeps {
  readonly description: string
  readonly render: (view: StatusView) => string
  /** From the cached `getMe`; undefined if it was never stored. */
  readonly botUsername: string | undefined
  readonly allowed: AllowedSenderStore
  /** Whether the MCP transport to Claude Code is open. */
  readonly isSessionConnected: () => boolean
  /** Open permission requests of this session. */
  readonly pendingPermissions: () => number
  readonly brake: Pick<BrakeFlag, 'status'>
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
        pendingPermissions: this.deps.pendingPermissions(),
        brake: this.#brake(),
      }),
    )
  }

  #brake(): StatusView['brake'] {
    const status = this.deps.brake.status()
    if (!status.engaged) return { engaged: false }
    return status.record === undefined
      ? { engaged: true }
      : { engaged: true, since: new Date(status.record.engagedAt).toISOString() }
  }
}
