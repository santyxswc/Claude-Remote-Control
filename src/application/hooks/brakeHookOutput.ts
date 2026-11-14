/**
 * What the PreToolUse hook prints while the brake is engaged: one JSON
 * object that refuses this tool call and stops Claude (hooks reference,
 * re-checked 2026-11-14). `continue: false` "takes precedence over any
 * event-specific decision fields"; the deny is kept so the call is refused
 * even by a Claude Code that ignored `continue`. `stopReason` is shown to the
 * user (and stays in the conversation); `permissionDecisionReason` goes to
 * Claude. Besides types it imports only the import-free domain record.
 */
import { type BrakeRecord, brakeSource } from '../../domain/brake/BrakeRecord.ts'
import type { Messages } from '../i18n/messages.ts'

export interface BrakeHookInput {
  /** Undefined when the flag file exists but cannot be read (still braked). */
  readonly record: BrakeRecord | undefined
  readonly flagPath: string
}

export function brakeHookOutput(
  input: BrakeHookInput,
  messages: Pick<Messages, 'brakeStopReason' | 'brakeToolDenied'>,
): string {
  const { record } = input
  const stopReason = messages.brakeStopReason({
    source: record === undefined ? undefined : brakeSource(record.actor),
    since: record === undefined ? undefined : new Date(record.engagedAt).toISOString(),
    reason: record?.reason,
    flagPath: input.flagPath,
  })
  return `${JSON.stringify({
    continue: false,
    stopReason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: messages.brakeToolDenied,
    },
  })}\n`
}
