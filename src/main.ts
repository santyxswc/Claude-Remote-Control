/**
 * Composition root of the channel. Claude Code spawns this process and talks
 * MCP over stdin/stdout, so nothing here may write to stdout: logs go to stderr.
 * Bigger pieces of wiring live in `src/composition/`.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import packageJson from '../package.json' with { type: 'json' }
import { DevChatGateway } from './adapters/dev/DevChatGateway.ts'
import {
  DEV_CHAT_ID,
  type DevHttpInbound,
  startDevHttpInbound,
} from './adapters/dev/DevHttpInbound.ts'
import { DEV_PORT_ENV, parseDevPort } from './adapters/dev/devPort.ts'
import { RedactingLogger } from './adapters/logging/RedactingLogger.ts'
import { StderrLogger } from './adapters/logging/StderrLogger.ts'
import { McpChannelServer } from './adapters/mcp/McpChannelServer.ts'
import { openState, type StateStores } from './adapters/storage/openState.ts'
import { defaultStateDir } from './adapters/storage/stateDir.ts'
import { DotEnvProjectSecrets } from './adapters/system/DotEnvProjectSecrets.ts'
import { SystemClock } from './adapters/system/SystemClock.ts'
import type { PollingSupervisor } from './adapters/telegram/PollingSupervisor.ts'
import { LOCALE_ENV, messagesFor, parseLocale } from './application/i18n/messages.ts'
import type { Logger } from './application/ports/Logger.ts'
import { buildOutbound } from './composition/outbound.ts'
import { buildSendReply } from './composition/replies.ts'
import { startTelegramInbound } from './composition/telegramInbound.ts'
import { selectSecretValues } from './domain/redaction/secretValues.ts'

const SERVER_NAME = 'telegram-bridge'
const PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR'

let logger: Logger = new StderrLogger()

process.on('unhandledRejection', (error) => logger.error('unhandled rejection', { error }))
process.on('uncaughtException', (error) => logger.error('uncaught exception', { error }))

const env = process.env
const clock = new SystemClock()
const messages = messagesFor(parseLocale(env[LOCALE_ENV]))
const devPort = parseDevPort(env[DEV_PORT_ENV])
const devReplies = devPort === undefined ? undefined : new DevChatGateway()
const stateDir = defaultStateDir()

// A broken state directory must not crash the server: Claude Code would mark it failed.
let state: StateStores | undefined
try {
  state = openState(stateDir, env, clock)
} catch (error) {
  logger.error('could not open the state directory; serving MCP without telegram', { error })
}
const token = state?.tokens.load()

// Claude Code may start us in the plugin directory; CLAUDE_PROJECT_DIR names the project.
const projectDir = env[PROJECT_DIR_ENV]
const projectDirs = projectDir ? [process.cwd(), projectDir] : [process.cwd()]
const literalSecrets = new DotEnvProjectSecrets(projectDirs, logger).load()
// Safety net: callers never log secrets, and the logger scrubs them anyway.
logger = new RedactingLogger(logger, [
  ...(token === undefined ? [] : [token]),
  ...selectSecretValues(literalSecrets),
])
const outbound = buildOutbound({ token, dev: devReplies, literalSecrets })
const sendReply = buildSendReply({
  state,
  chat: outbound,
  extraChatIds: devReplies === undefined ? [] : [DEV_CHAT_ID],
  clock,
  logger,
})

const channel = new McpChannelServer({
  name: SERVER_NAME,
  version: packageJson.version,
  reply: (request) => sendReply.execute(request),
  logger,
})

let devInbound: DevHttpInbound | undefined
let polling: PollingSupervisor | undefined
let shuttingDown = false

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('shutting down', { reason })
  // Never hang on exit: a stuck close must not leave an orphan process behind.
  setTimeout(() => process.exit(0), 2000).unref()
  await polling?.stop()
  state?.db.close()
  await devInbound?.stop()
  await channel.close()
  process.exit(0)
}

channel.onClose(() => void shutdown('transport closed'))
// Claude Code closing our stdin is the reliable "session ended" signal on every OS.
process.stdin.on('end', () => void shutdown('stdin ended'))
process.stdin.on('close', () => void shutdown('stdin closed'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await channel.connect(new StdioServerTransport())
logger.info('channel connected', { stateDir })

if (state !== undefined && token === undefined) {
  logger.warn('telegram is not configured; run `bun run bridge -- init`, then `pair`')
} else if (state !== undefined && token !== undefined) {
  try {
    polling = startTelegramInbound({
      state,
      token,
      chat: outbound,
      channel,
      messages,
      clock,
      logger,
    })
  } catch (error) {
    logger.error('telegram setup failed; serving MCP without it', { error })
  }
}

if (devPort !== undefined && devReplies !== undefined) {
  try {
    devInbound = startDevHttpInbound({ port: devPort, channel, replies: devReplies, logger })
  } catch (error) {
    // E.g. another session already holds the port; keep serving MCP without the listener.
    logger.error('dev inbound failed to start', { port: devPort, error })
  }
}
