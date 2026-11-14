#!/usr/bin/env bun
/**
 * PreToolUse hook entrypoint (F6): `bun src/brakeHook.ts`, run by Claude Code
 * before every tool call, synchronously, so it can refuse the call.
 *
 * - No brake flag: exit 0 with nothing on stdout; the call goes on. This is
 *   the path taken on every tool call, so it is one failed `open` and
 *   nothing else: no stdin, no IPC, no catalog.
 * - Flag engaged, or present but unreadable: exit 0 with one JSON object
 *   that denies the call and stops Claude (`brakeHookOutput`).
 *
 * Failure policy (ADR 0003): if the state directory cannot even be resolved,
 * the hook fails open; anything that goes wrong once a flag file exists
 * fails closed. Diagnostics go to stderr only with TELEGRAM_BRIDGE_DEBUG=1.
 */
import { type BrakeFileState, brakeFilePath, readBrakeFile } from './adapters/storage/brakeFile.ts'
import { defaultStateDir } from './adapters/storage/stateDir.ts'

const DEBUG_ENV = 'TELEGRAM_BRIDGE_DEBUG'
const debugEnabled = process.env[DEBUG_ENV] === '1'

function debug(message: string): void {
  if (debugEnabled) process.stderr.write(`telegram-bridge brake hook: ${message}\n`)
}

/**
 * Printed if the catalog or the renderer cannot be loaded: still a stop.
 * The one user-facing text outside `messages.ts`, on purpose: it must not
 * depend on anything that could be the reason the catalog failed.
 */
const FALLBACK_OUTPUT = `${JSON.stringify({
  continue: false,
  stopReason:
    'telegram-bridge: the brake is engaged. To release it send /resume in Telegram or run "telegram-bridge resume".',
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'The telegram-bridge brake is engaged.',
  },
})}\n`

async function render(state: BrakeFileState, flagPath: string): Promise<string> {
  try {
    const { LOCALE_ENV, messagesFor, parseLocale } = await import('./application/i18n/messages.ts')
    const { brakeHookOutput } = await import('./application/hooks/brakeHookOutput.ts')
    const record = state.kind === 'engaged' ? state.record : undefined
    return brakeHookOutput({ record, flagPath }, messagesFor(parseLocale(process.env[LOCALE_ENV])))
  } catch (error) {
    debug(`rendering failed: ${error instanceof Error ? error.message : String(error)}`)
    return FALLBACK_OUTPUT
  }
}

let stateDir: string | undefined
try {
  stateDir = defaultStateDir()
} catch (error) {
  debug(`no state directory: ${error instanceof Error ? error.message : String(error)}`)
}

const state: BrakeFileState = stateDir === undefined ? { kind: 'absent' } : readBrakeFile(stateDir)
debug(state.kind)
if (state.kind !== 'absent' && stateDir !== undefined) {
  process.stdout.write(await render(state, brakeFilePath(stateDir)))
}
