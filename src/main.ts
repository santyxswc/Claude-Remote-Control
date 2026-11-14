/**
 * Composition root of the channel. Claude Code spawns this process and talks
 * MCP over stdin/stdout, so nothing here may write to stdout: logs go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import packageJson from '../package.json' with { type: 'json' }
import { DevChatGateway } from './adapters/dev/DevChatGateway.ts'
import { type DevHttpInbound, startDevHttpInbound } from './adapters/dev/DevHttpInbound.ts'
import { DEV_PORT_ENV, parseDevPort } from './adapters/dev/devPort.ts'
import { RedactingLogger } from './adapters/logging/RedactingLogger.ts'
import { StderrLogger } from './adapters/logging/StderrLogger.ts'
import { McpChannelServer } from './adapters/mcp/McpChannelServer.ts'
import { openState, type StateStores } from './adapters/storage/openState.ts'
import { LOCK_HEARTBEAT_MS } from './adapters/storage/SqlitePollerLock.ts'
import { defaultStateDir } from './adapters/storage/stateDir.ts'
import { Sha256SecretHasher } from './adapters/system/Sha256SecretHasher.ts'
import { SystemClock } from './adapters/system/SystemClock.ts'
import { PollingSupervisor } from './adapters/telegram/PollingSupervisor.ts'
import { TelegramChatGateway } from './adapters/telegram/TelegramChatGateway.ts'
import { TelegramPoller } from './adapters/telegram/TelegramPoller.ts'
import { LOCALE_ENV, messagesFor, parseLocale } from './application/i18n/messages.ts'
import { createInboundPipeline } from './application/pipeline/createInboundPipeline.ts'
import type { ChatGateway } from './application/ports/ChatGateway.ts'
import type { Logger } from './application/ports/Logger.ts'
import { AuthorizeSender } from './application/use-cases/AuthorizeSender.ts'
import { ClaimPairing } from './application/use-cases/ClaimPairing.ts'

const SERVER_NAME = 'telegram-bridge'

/** While another process polls the bot, check this often whether it has finished. */
const LOCK_RETRY_MS = 30_000

let logger: Logger = new StderrLogger()

process.on('unhandledRejection', (error) => logger.error('unhandled rejection', { error }))
process.on('uncaughtException', (error) => logger.error('uncaught exception', { error }))

const devPort = parseDevPort(process.env[DEV_PORT_ENV])
const devReplies = new DevChatGateway()

/**
 * The `reply` tool is wired to Telegram in F2, together with the outbound
 * redaction pipeline; until then replies only work in dev mode.
 */
const noChatPlatform: ChatGateway = {
  async sendText() {
    throw new Error(`no chat platform configured yet; set ${DEV_PORT_ENV} for local testing`)
  },
}

const channel = new McpChannelServer({
  name: SERVER_NAME,
  version: packageJson.version,
  chat: devPort === undefined ? noChatPlatform : devReplies,
  logger,
})

let devInbound: DevHttpInbound | undefined
let state: StateStores | undefined
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
const stateDir = defaultStateDir()
logger.info('channel connected', { stateDir })

/**
 * Starts Telegram polling when a token is configured. Any failure here is
 * logged and the MCP server keeps running: crashing would make Claude Code
 * mark the server as failed.
 */
function startTelegram(): void {
  const clock = new SystemClock()
  state = openState(stateDir, process.env, clock)
  const token = state.tokens.load()
  if (token === undefined) {
    logger.warn('telegram is not configured; run `bun run bridge -- init`, then `pair`')
    return
  }
  logger = new RedactingLogger(logger, [token])
  const hasher = new Sha256SecretHasher()
  const lifecycle = { pairings: state.pairings, audit: state.audit }
  const pipeline = createInboundPipeline({
    claimPairing: new ClaimPairing({ ...lifecycle, hasher, clock }),
    authorizeSender: new AuthorizeSender(state.allowed),
    chat: new TelegramChatGateway(token),
    messages: messagesFor(parseLocale(process.env[LOCALE_ENV])),
    logger,
  })
  polling = new PollingSupervisor({
    lock: state.lock,
    poller: new TelegramPoller({ token, logger }),
    handler: pipeline,
    logger,
    role: 'channel',
    heartbeatMs: LOCK_HEARTBEAT_MS,
    retryMs: LOCK_RETRY_MS,
  })
  polling.start()
}

try {
  startTelegram()
} catch (error) {
  logger.error('telegram setup failed; serving MCP without it', { error })
}

if (devPort !== undefined) {
  try {
    devInbound = startDevHttpInbound({ port: devPort, channel, replies: devReplies, logger })
  } catch (error) {
    // E.g. another session already holds the port; keep serving MCP without the listener.
    logger.error('dev inbound failed to start', { port: devPort, error })
  }
}
