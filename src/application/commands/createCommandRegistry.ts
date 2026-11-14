import type { Messages } from '../i18n/messages.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { ResumeSession } from '../use-cases/ResumeSession.ts'
import type { StopSession } from '../use-cases/StopSession.ts'
import { CommandRegistry } from './CommandRegistry.ts'
import { HelpCommand } from './HelpCommand.ts'
import { ResumeCommand } from './ResumeCommand.ts'
import { StartCommand } from './StartCommand.ts'
import { StatusCommand } from './StatusCommand.ts'
import { StopCommand } from './StopCommand.ts'

export interface CommandRegistryDeps {
  readonly messages: Messages
  readonly botUsername: string | undefined
  readonly allowed: AllowedSenderStore
  readonly isSessionConnected: () => boolean
  readonly pendingPermissions: () => number
  readonly brake: Pick<BrakeFlag, 'status'>
  readonly stopSession: StopSession
  readonly resumeSession: ResumeSession
}

/** The chat commands, in `/help` order. Later flows register `/shot` here. */
export function createCommandRegistry(deps: CommandRegistryDeps): CommandRegistry {
  const { messages } = deps
  const registry = new CommandRegistry()
  return registry
    .register(new StartCommand(messages.commandStartDescription, messages.startGreeting))
    .register(new HelpCommand(messages.commandHelpDescription, registry, messages.help))
    .register(
      new StatusCommand({
        description: messages.commandStatusDescription,
        render: messages.status,
        botUsername: deps.botUsername,
        allowed: deps.allowed,
        isSessionConnected: deps.isSessionConnected,
        pendingPermissions: deps.pendingPermissions,
        brake: deps.brake,
      }),
    )
    .register(
      new StopCommand(messages.commandStopDescription, deps.stopSession, messages.stopReport),
    )
    .register(
      new ResumeCommand(messages.commandResumeDescription, deps.resumeSession, {
        released: messages.resumeReleased,
        notEngaged: messages.resumeNotEngaged,
      }),
    )
}
