import type { Messages } from '../i18n/messages.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'
import { CommandRegistry } from './CommandRegistry.ts'
import { HelpCommand } from './HelpCommand.ts'
import { StartCommand } from './StartCommand.ts'
import { StatusCommand } from './StatusCommand.ts'

export interface CommandRegistryDeps {
  readonly messages: Messages
  readonly botUsername: string | undefined
  readonly allowed: AllowedSenderStore
  readonly isSessionConnected: () => boolean
}

/** The F2 commands. Later flows register `/stop`, `/shot`, `/resume` here. */
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
      }),
    )
}
