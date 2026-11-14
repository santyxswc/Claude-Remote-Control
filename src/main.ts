/**
 * Composition root. Claude Code spawns this process and talks MCP over
 * stdin/stdout, so nothing here may write to stdout: logs go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import packageJson from '../package.json' with { type: 'json' }
import { DevChatGateway } from './adapters/dev/DevChatGateway.ts'
import { type DevHttpInbound, startDevHttpInbound } from './adapters/dev/DevHttpInbound.ts'
import { DEV_PORT_ENV, parseDevPort } from './adapters/dev/devPort.ts'
import { StderrLogger } from './adapters/logging/StderrLogger.ts'
import { McpChannelServer } from './adapters/mcp/McpChannelServer.ts'
import { defaultStateDir } from './adapters/storage/stateDir.ts'
import type { ChatGateway } from './application/ports/ChatGateway.ts'

const SERVER_NAME = 'telegram-bridge'

const logger = new StderrLogger()

process.on('unhandledRejection', (error) => logger.error('unhandled rejection', { error }))
process.on('uncaughtException', (error) => logger.error('uncaught exception', { error }))

const devPort = parseDevPort(process.env[DEV_PORT_ENV])
const devReplies = new DevChatGateway()

/** Until the Telegram adapter exists (F2), replies only work in dev mode. */
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
let shuttingDown = false

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('shutting down', { reason })
  // Never hang on exit: a stuck close must not leave an orphan process behind.
  setTimeout(() => process.exit(0), 2000).unref()
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
logger.info('channel connected', { stateDir: defaultStateDir() })

if (devPort !== undefined) {
  try {
    devInbound = startDevHttpInbound({ port: devPort, channel, replies: devReplies, logger })
  } catch (error) {
    // E.g. another session already holds the port; keep serving MCP without the listener.
    logger.error('dev inbound failed to start', { port: devPort, error })
  }
}
