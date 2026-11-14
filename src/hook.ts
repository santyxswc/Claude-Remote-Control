#!/usr/bin/env bun
/**
 * Hook entrypoint: `bun src/hook.ts <EventName>` with the hook JSON on stdin.
 * Forwards the event to the running channel over local IPC and exits 0.
 *
 * It runs inside the user's Claude Code session on every matching event, so
 * it fails open: it always exits 0 with nothing on stdout (Claude Code reads
 * stdout), whether the bridge is not running, not configured or broken, and
 * it gives up after a hard deadline. Only node builtins are loaded (no zod,
 * grammY, MCP SDK or SQLite) to keep the start fast. Diagnostics go to
 * stderr only with TELEGRAM_BRIDGE_DEBUG=1.
 */
import { hookEndpoint } from './adapters/ipc/endpoint.ts'
import { encodeFrame } from './adapters/ipc/frame.ts'
import { sendHookFrame } from './adapters/ipc/hookClient.ts'
import { projectHookPayload } from './adapters/ipc/hookPayload.ts'
import { readHookSecret } from './adapters/ipc/hookSecret.ts'
import { defaultStateDir } from './adapters/storage/stateDir.ts'
import { isHookEventName } from './application/hooks/hookEventNames.ts'

/** Whatever happens, the process is gone by then. */
const DEADLINE_MS = 1_500
/** Part of the deadline left for the channel to acknowledge. */
const SEND_TIMEOUT_MS = 1_000
/** Larger stdin is not read to the end; such an event is dropped. */
const MAX_STDIN_BYTES = 4 * 1024 * 1024

const DEBUG_ENV = 'TELEGRAM_BRIDGE_DEBUG'

const debugEnabled = process.env[DEBUG_ENV] === '1'

function debug(message: string): void {
  if (debugEnabled) process.stderr.write(`telegram-bridge hook: ${message}\n`)
}

// Not unref'd: this timer is what guarantees the exit.
setTimeout(() => {
  debug('deadline reached')
  process.exit(0)
}, DEADLINE_MS)

async function readStdin(): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buffer.length
    if (size > MAX_STDIN_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Forwards the event; returns what happened, for the debug line. */
async function run(): Promise<string> {
  const event = process.argv[2]
  if (!isHookEventName(event)) return `not a handled event: ${String(event)}`
  const stateDir = defaultStateDir()
  // No secret means the channel never listened here: not configured or not running.
  const secret = readHookSecret(stateDir)
  if (secret === undefined) return 'no hook secret; the bridge has not run here'
  const text = await readStdin()
  if (text === undefined) return 'stdin too large; event dropped'
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return 'stdin is not JSON'
  }
  const frame = encodeFrame(secret, JSON.stringify(projectHookPayload(event, raw)))
  const outcome = await sendHookFrame(hookEndpoint(stateDir), frame, SEND_TIMEOUT_MS)
  return `${event}: ${outcome}`
}

try {
  debug(await run())
} catch (error) {
  debug(`failed: ${error instanceof Error ? error.message : String(error)}`)
}
process.exit(0)
