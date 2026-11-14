/**
 * Composition root of the channel. Claude Code spawns this process and talks
 * MCP over stdin/stdout, so nothing here may write to stdout: logs go to stderr.
 * Bigger pieces of wiring live in `src/composition/`.
 */
import { existsSync } from 'node:fs'
import { devNull, homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import packageJson from '../package.json' with { type: 'json' }
import { createScreenCapturers } from './adapters/capture/createScreenCapturers.ts'
import { systemProbe } from './adapters/capture/systemProbe.ts'
import { ProcessChartRenderer } from './adapters/chart/ProcessChartRenderer.ts'
import { DevChatGateway } from './adapters/dev/DevChatGateway.ts'
import {
  DEV_CHAT_ID,
  type DevHttpInbound,
  startDevHttpInbound,
} from './adapters/dev/DevHttpInbound.ts'
import { DEV_PORT_ENV, devListenerPort } from './adapters/dev/devPort.ts'
import { GitCli } from './adapters/git/GitCli.ts'
import { RedactingLogger } from './adapters/logging/RedactingLogger.ts'
import { StderrLogger } from './adapters/logging/StderrLogger.ts'
import { McpChannelServer } from './adapters/mcp/McpChannelServer.ts'
import { createSessionController } from './adapters/session/createSessionController.ts'
import { spawnCapturing, spawnProcess } from './adapters/session/processRunner.ts'
import { DiskSkillFiles, resolveProjectDir } from './adapters/skills/DiskSkillFiles.ts'
import { TOKEN_ENV } from './adapters/storage/DotEnvTokenStore.ts'
import { openState, type StateStores } from './adapters/storage/openState.ts'
import { defaultStateDir, resolveClaudeConfigDir } from './adapters/storage/stateDir.ts'
import { DotEnvProjectSecrets } from './adapters/system/DotEnvProjectSecrets.ts'
import { SystemClock } from './adapters/system/SystemClock.ts'
import { LOCALE_ENV, messagesFor, parseLocale } from './application/i18n/messages.ts'
import type { HookEventSource } from './application/ports/HookEventSource.ts'
import type { Logger } from './application/ports/Logger.ts'
import { buildCharts } from './composition/charts.ts'
import { createHookIpcServer, createSessionTracking } from './composition/hooks.ts'
import { buildOutbound } from './composition/outbound.ts'
import { buildSendReply } from './composition/replies.ts'
import { buildScreenshots } from './composition/screenshots.ts'
import { startTelegramInbound, type TelegramInbound } from './composition/telegramInbound.ts'
import { maxUploadBytes } from './domain/attachments/attachmentPolicy.ts'
import { projectName } from './domain/notices/sessionNotices.ts'
import { selectSecretValues } from './domain/redaction/secretValues.ts'

const SERVER_NAME = 'telegram-bridge'
const PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR'
const MAX_UPLOAD_ENV = 'TELEGRAM_BRIDGE_MAX_UPLOAD_MB'

let logger: Logger = new StderrLogger()

process.on('unhandledRejection', (error) => logger.error('unhandled rejection', { error }))
process.on('uncaughtException', (error) => logger.error('uncaught exception', { error }))

const env = process.env
const clock = new SystemClock()
const messages = messagesFor(parseLocale(env[LOCALE_ENV]))

// A broken state directory must not crash the server: Claude Code would mark it failed.
// A relative TELEGRAM_BRIDGE_HOME or CLAUDE_CONFIG_DIR is refused, never resolved against cwd.
let stateDir: string | undefined
let state: StateStores | undefined
try {
  stateDir = defaultStateDir()
  state = openState(stateDir, env, clock)
} catch (error) {
  logger.error('could not use the state directory; serving MCP without telegram', { error })
}
const token = state?.tokens.load()

// Only for trying the channel without a bot; a typo is logged, never fatal (M4, ADR 0005).
const devPort = devListenerPort({
  raw: env[DEV_PORT_ENV],
  botConfigured: token !== undefined || (env[TOKEN_ENV] ?? '').trim() !== '',
  logger,
})
const devReplies = devPort === undefined ? undefined : new DevChatGateway()

// Claude Code may start us in the plugin directory; CLAUDE_PROJECT_DIR names the project.
const projectDir = env[PROJECT_DIR_ENV]
const projectDirs = projectDir ? [process.cwd(), projectDir] : [process.cwd()]
const literalSecrets = new DotEnvProjectSecrets(projectDirs, logger).load()
// Safety net: callers never log secrets, and the logger scrubs them anyway.
logger = new RedactingLogger(logger, [
  ...(token === undefined ? [] : [token]),
  ...selectSecretValues(literalSecrets),
])
// F11: charts are drawn in a child process; Vega and resvg are never loaded here.
const outbound = buildOutbound({
  token,
  dev: devReplies,
  literalSecrets,
  charts: new ProcessChartRenderer(),
})
const tracking = createSessionTracking(clock)
const sendReply = buildSendReply({
  state,
  chat: outbound,
  extraChatIds: devReplies === undefined ? [] : [DEV_CHAT_ID],
  clock,
  logger,
  onSent: () => tracking.policy.replied(clock.now()),
})

// F5: only where images can reach an allowlisted chat (a token and the state directory).
const screenshots =
  state === undefined || token === undefined || stateDir === undefined
    ? undefined
    : buildScreenshots({
        stateDir,
        state,
        setup: createScreenCapturers({
          platform: process.platform,
          env,
          homeDir: homedir(),
          probe: systemProbe,
          run: spawnProcess,
          logger,
        }),
        images: outbound,
        messages,
        clock,
        logger,
      })
const canCapture = screenshots !== undefined && screenshots.availableKinds().length > 0
if (screenshots !== undefined) {
  logger.info('screenshot capture', { kinds: screenshots.availableKinds() })
}

// F11: like screenshots, only where images can reach an allowlisted chat.
const charts =
  state === undefined || token === undefined || stateDir === undefined
    ? undefined
    : buildCharts({ stateDir, state, outbound, messages, clock, logger })

/** F12's tools need the polling side (buttons, notices); it is set up after connecting. */
function memoryWiring() {
  const memory = polling?.memory
  if (memory === undefined) throw new Error('telegram is not set up in this process')
  return memory
}

const channel = new McpChannelServer({
  name: SERVER_NAME,
  version: packageJson.version,
  reply: (request) => sendReply.execute(request),
  logger,
  // Permission prompts only where senders are authenticated: a token and the allowlist.
  permissionRelay: state !== undefined && token !== undefined,
  ...(canCapture ? { screenshot: (request) => screenshots.execute(request) } : {}),
  // F7: buttons exist only with a token and the allowlist; taps reach only the polling process.
  ...(state !== undefined && token !== undefined
    ? {
        askChoice: async (request) =>
          polling === undefined
            ? { status: 'refused', reason: 'not_polling' }
            : polling.choices.ask.execute(request),
        saveSummary: (request) => memoryWiring().saveSummary.execute(request),
        proposeMemory: async (request) =>
          polling?.memory === undefined
            ? { status: 'refused', reason: 'not_polling' }
            : polling.memory.propose.execute(request),
      }
    : {}),
  ...(charts === undefined ? {} : { chart: (request) => charts.execute(request) }),
})

let devInbound: DevHttpInbound | undefined
let polling: TelegramInbound | undefined
let shuttingDown = false

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('shutting down', { reason })
  // Never hang on exit: a stuck close must not leave an orphan process behind.
  setTimeout(() => process.exit(0), 2000).unref()
  // A capture in flight is cancelled (its program killed, its files removed), never orphaned.
  await screenshots?.stop()
  // The same for a chart being drawn: its process is killed.
  await charts?.stop()
  await polling?.stop()
  state?.db.close()
  await devInbound?.stop()
  await channel.close()
  process.exit(0)
}

/** Without the hook listener there are no notices; everything else keeps working. */
function hookListenerOrNothing(dir: string): HookEventSource | undefined {
  try {
    return createHookIpcServer(dir, logger)
  } catch (error) {
    logger.error('the hook listener cannot be set up; notices are off', { error })
    return undefined
  }
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
} else if (state !== undefined && token !== undefined && stateDir !== undefined) {
  const upload = maxUploadBytes(env[MAX_UPLOAD_ENV])
  if (upload.invalid) {
    logger.warn(`${MAX_UPLOAD_ENV} must be a whole number of MB from 1 to 20; using 20`)
  }
  const knownProject = resolveProjectDir(env, process.cwd(), existsSync)
  // F8: git runs in the project (CLAUDE_PROJECT_DIR, else the directory we started in).
  const gitDir = projectDir !== undefined && isAbsolute(projectDir) ? projectDir : process.cwd()
  const project = projectName(gitDir)
  const git = new GitCli({
    // Resolved once, from PATH: never a `git` sitting in the project directory.
    gitPath: Bun.which('git') ?? undefined,
    cwd: gitDir,
    env,
    devNull,
    run: spawnCapturing,
  })
  let configDir: string | undefined
  try {
    configDir = resolveClaudeConfigDir(env, homedir())
  } catch (error) {
    logger.warn('personal skills are not listed: the config directory is invalid', { error })
  }
  try {
    polling = startTelegramInbound({
      state,
      token,
      chat: outbound,
      channel,
      messages,
      clock,
      logger,
      tracking,
      hooks: hookListenerOrNothing(stateDir),
      // tmux (any non-Windows OS) when Claude Code runs in a pane; otherwise /stop relies on the hook brake.
      sessionController: createSessionController({
        platform: process.platform,
        env,
        run: spawnProcess,
        logger,
      }),
      ...(screenshots === undefined ? {} : { screenshots }),
      attachments: { stateDir, maxBytes: upload.bytes },
      skillFiles: new DiskSkillFiles({
        projectDir: knownProject,
        userSkillsDir: configDir === undefined ? undefined : join(configDir, 'skills'),
        logger,
      }),
      git,
      ...(project === undefined ? {} : { project }),
      // F12: summaries and CLAUDE.md go to the same project directory as git.
      projectDir: gitDir,
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
