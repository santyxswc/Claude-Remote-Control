import type { GitStatusLineView, Messages } from '../i18n/messages.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { SkillsMenu } from '../skills/SkillsMenu.ts'
import type { CaptureScreenshot } from '../use-cases/CaptureScreenshot.ts'
import type { PinStatusMessage } from '../use-cases/PinStatusMessage.ts'
import type { ResumeSession } from '../use-cases/ResumeSession.ts'
import type { ShowDiff } from '../use-cases/ShowDiff.ts'
import type { StopSession } from '../use-cases/StopSession.ts'
import type { UnpinStatusMessage } from '../use-cases/UnpinStatusMessage.ts'
import { CommandRegistry } from './CommandRegistry.ts'
import { DiffCommand } from './DiffCommand.ts'
import { HelpCommand } from './HelpCommand.ts'
import { PinCommand } from './PinCommand.ts'
import { ResumeCommand } from './ResumeCommand.ts'
import { ShotCommand } from './ShotCommand.ts'
import { SkillsCommand } from './SkillsCommand.ts'
import { StartCommand } from './StartCommand.ts'
import { StatusCommand } from './StatusCommand.ts'
import { StopCommand } from './StopCommand.ts'
import { UnpinCommand } from './UnpinCommand.ts'

export interface CommandRegistryDeps {
  readonly messages: Messages
  readonly botUsername: string | undefined
  readonly allowed: AllowedSenderStore
  readonly isSessionConnected: () => boolean
  readonly pendingPermissions: () => number
  readonly brake: Pick<BrakeFlag, 'status'>
  readonly stopSession: StopSession
  readonly resumeSession: ResumeSession
  /** F5; without it there is no `/shot`. */
  readonly screenshots?: Pick<CaptureScreenshot, 'start' | 'availableKinds'>
  /** F7; without it there is no `/skills`. */
  readonly skills?: Pick<SkillsMenu, 'send'>
  /** F10: inbox usage for `/status`. */
  readonly inboxUsage?: () => Promise<{ readonly files: number; readonly bytes: number }>
  /** F8; without it there is no `/diff` and no git line in `/status`. */
  readonly git?: {
    readonly diff: Pick<ShowDiff, 'start'>
    readonly statusLine: () => Promise<GitStatusLineView | undefined>
  }
  /** F9; without it there is no `/pin` or `/unpin`. */
  readonly statusMessage?: {
    readonly pin: Pick<PinStatusMessage, 'execute'>
    readonly unpin: Pick<UnpinStatusMessage, 'execute'>
  }
}

/** The chat commands, in `/help` order. */
export function createCommandRegistry(deps: CommandRegistryDeps): CommandRegistry {
  const { messages, screenshots } = deps
  const registry = new CommandRegistry()
  registry
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
        ...(screenshots === undefined ? {} : { captureKinds: () => screenshots.availableKinds() }),
        ...(deps.inboxUsage === undefined ? {} : { inbox: deps.inboxUsage }),
        ...(deps.git === undefined ? {} : { git: deps.git.statusLine }),
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
  if (screenshots !== undefined) {
    registry.register(
      new ShotCommand(
        messages.commandShotDescription,
        screenshots,
        messages.shotProblem,
        messages.shotCapturing,
      ),
    )
  }
  if (deps.skills !== undefined) {
    registry.register(new SkillsCommand(messages.commandSkillsDescription, deps.skills))
  }
  if (deps.git !== undefined) {
    registry.register(
      new DiffCommand(messages.commandDiffDescription, deps.git.diff, messages.diffProblem),
    )
  }
  if (deps.statusMessage !== undefined) {
    registry
      .register(
        new PinCommand(messages.commandPinDescription, deps.statusMessage.pin, {
          failed: messages.pinFailed,
          notPinned: messages.pinNotPinned,
        }),
      )
      .register(
        new UnpinCommand(messages.commandUnpinDescription, deps.statusMessage.unpin, {
          done: messages.unpinDone,
          nothing: messages.unpinNothing,
        }),
      )
  }
  return registry
}
