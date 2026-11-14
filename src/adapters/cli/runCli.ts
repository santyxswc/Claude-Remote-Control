import type { Messages } from '../../application/i18n/messages.ts'
import type { Terminal } from '../../application/ports/Terminal.ts'
import { InvalidStateDirError } from '../storage/stateDir.ts'
import { type AccessCommandDeps, runAccessList, runAccessRevoke } from './accessCommands.ts'
import { type BrakeCommandDeps, runResume, runStop } from './brakeCommands.ts'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exitCodes.ts'
import {
  type HubInitDeps,
  type HubOffDeps,
  type HubRunDeps,
  type HubStatusDeps,
  runHubInit,
  runHubOff,
  runHubRun,
  runHubStatus,
} from './hubCommands.ts'
import { type InitCommandDeps, runInit } from './initCommand.ts'
import { type PairCommandDeps, runPair } from './pairCommand.ts'

export type CliCommand =
  | { readonly name: 'help' }
  | { readonly name: 'init'; readonly fromStdin: boolean }
  | { readonly name: 'pair' }
  | { readonly name: 'access-list' }
  | { readonly name: 'access-revoke'; readonly id: string }
  | { readonly name: 'stop'; readonly reason: string | undefined }
  | { readonly name: 'resume' }
  | { readonly name: 'hub-init' }
  | { readonly name: 'hub-run' }
  | { readonly name: 'hub-status' }
  | { readonly name: 'hub-off' }

/** Parses argv (without the runtime and script). Undefined means a usage error. */
export function parseArgs(argv: readonly string[]): CliCommand | undefined {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const [command, ...rest] = args
  switch (command) {
    case '--help':
    case '-h':
    case 'help':
      return rest.length === 0 ? { name: 'help' } : undefined
    case 'init':
      if (rest.length === 0) return { name: 'init', fromStdin: false }
      if (rest.length === 1 && rest[0] === '--token-stdin') return { name: 'init', fromStdin: true }
      return undefined
    case 'pair':
      return rest.length === 0 ? { name: 'pair' } : undefined
    case 'access':
      if (rest.length === 1 && rest[0] === 'list') return { name: 'access-list' }
      if (rest.length === 2 && rest[0] === 'revoke' && rest[1] !== undefined) {
        return { name: 'access-revoke', id: rest[1] }
      }
      return undefined
    case 'stop':
      return { name: 'stop', reason: rest.length === 0 ? undefined : rest.join(' ') }
    case 'resume':
      return rest.length === 0 ? { name: 'resume' } : undefined
    case 'hub':
      return parseHub(rest)
    default:
      return undefined
  }
}

/** F14: `hub` alone runs the daemon, like `hub run`. */
function parseHub(rest: readonly string[]): CliCommand | undefined {
  if (rest.length === 0) return { name: 'hub-run' }
  if (rest.length !== 1) return undefined
  switch (rest[0]) {
    case 'init':
      return { name: 'hub-init' }
    case 'run':
      return { name: 'hub-run' }
    case 'status':
      return { name: 'hub-status' }
    case 'off':
      return { name: 'hub-off' }
    default:
      return undefined
  }
}

/**
 * Builds each command's dependencies only when that command runs, so
 * `--help` or a usage error touches no files and no network.
 */
export interface CliContext {
  readonly terminal: Terminal
  readonly messages: Messages
  readonly init: () => InitCommandDeps
  readonly pair: () => PairCommandDeps
  readonly access: () => AccessCommandDeps
  readonly brake: () => BrakeCommandDeps
  readonly hubInit: () => HubInitDeps
  readonly hubRun: () => HubRunDeps
  readonly hubStatus: () => HubStatusDeps
  readonly hubOff: () => HubOffDeps
}

/** Runs one command and returns the process exit code (0 ok, 1 failure, 2 usage). */
export async function runCli(argv: readonly string[], context: CliContext): Promise<number> {
  const { terminal, messages } = context
  const command = parseArgs(argv)
  if (command === undefined) {
    // Never echo the arguments: a token pasted by mistake must not be printed back.
    terminal.error(messages.unknownCommand)
    terminal.error(messages.usage)
    return EXIT_USAGE
  }

  try {
    switch (command.name) {
      case 'help':
        terminal.print(messages.usage)
        return EXIT_OK
      case 'init':
        return await runInit(context.init(), command.fromStdin)
      case 'pair':
        return await runPair(context.pair())
      case 'access-list':
        return runAccessList(context.access())
      case 'access-revoke':
        return runAccessRevoke(context.access(), command.id)
      case 'stop':
        return runStop(context.brake(), command.reason)
      case 'resume':
        return runResume(context.brake())
      case 'hub-init':
        return await runHubInit(context.hubInit())
      case 'hub-run':
        return await runHubRun(context.hubRun())
      case 'hub-status':
        return runHubStatus(context.hubStatus())
      case 'hub-off':
        return runHubOff(context.hubOff())
    }
  } catch (error) {
    if (error instanceof InvalidStateDirError) {
      terminal.error(messages.invalidStateDir(error.variable))
      return EXIT_FAILURE
    }
    terminal.error(messages.unexpectedError(error instanceof Error ? error.message : String(error)))
    return EXIT_FAILURE
  }
}
