import {
  BotUnreachableError,
  InvalidBotTokenError,
  TerminalUnavailableError,
} from '../../application/errors.ts'
import type { Messages } from '../../application/i18n/messages.ts'
import type { Terminal } from '../../application/ports/Terminal.ts'
import type { InitBot } from '../../application/use-cases/InitBot.ts'
import { EXIT_FAILURE, EXIT_OK } from './exitCodes.ts'

export interface InitCommandDeps {
  readonly terminal: Terminal
  readonly messages: Messages
  readonly initBot: InitBot
  /** The `TELEGRAM_BOT_TOKEN` variable is set and wins over the saved file. */
  readonly tokenOverriddenByEnv: boolean
}

/**
 * `init`: reads the BotFather token without echo (or from a pipe with
 * `--token-stdin`), validates it and saves it. The token is never accepted
 * as an argument, where it would land in shell history and process lists.
 */
export async function runInit(deps: InitCommandDeps, fromStdin: boolean): Promise<number> {
  const { terminal, messages } = deps

  let token: string
  try {
    const raw = fromStdin
      ? await terminal.readPipedInput()
      : await terminal.askSecret(messages.initTokenPrompt)
    token = raw.trim()
  } catch (error) {
    if (!(error instanceof TerminalUnavailableError)) throw error
    terminal.error(fromStdin ? messages.initStdinIsTerminal : messages.initNeedsTerminal)
    return EXIT_FAILURE
  }
  if (token === '') {
    terminal.error(messages.initTokenEmpty)
    return EXIT_FAILURE
  }

  terminal.print(messages.initValidating)
  try {
    const identity = await deps.initBot.execute(token)
    terminal.print(messages.initDone(identity.username))
  } catch (error) {
    if (error instanceof InvalidBotTokenError) {
      terminal.error(messages.initInvalidToken)
      return EXIT_FAILURE
    }
    if (error instanceof BotUnreachableError) {
      terminal.error(messages.initUnreachable(error.detail))
      return EXIT_FAILURE
    }
    throw error
  }
  if (deps.tokenOverriddenByEnv) terminal.print(messages.initEnvOverride)
  terminal.print(messages.initNextStep)
  return EXIT_OK
}
