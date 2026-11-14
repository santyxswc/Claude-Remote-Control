import { elideMiddle } from '../../domain/elideMiddle.ts'
import {
  CONFIRMATION_WINDOW_MS,
  type PermissionRequest,
} from '../../domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { Messages } from '../i18n/messages.ts'
import type { PromptKeyboard } from '../ports/PromptGateway.ts'
import { encodePermissionCallback } from './callbackData.ts'

/**
 * The whole prompt must fit one message (Telegram: 4096). This leaves room
 * for redaction, which can make text longer (`[REDACTED]` is 10 characters).
 */
export const PROMPT_TEXT_BUDGET = 3500
const TOOL_NAME_BUDGET = 100
const DESCRIPTION_BUDGET = 600
const MIN_PREVIEW_BUDGET = 200

/** How a decision was reached, when the state alone does not say it (a `/stop`). */
export type DecisionCause = 'stop'

export interface RenderedPrompt {
  readonly text: string
  readonly keyboard: PromptKeyboard
}

/**
 * The prompt as it should look in the request's current state: content,
 * a status line once something happened, and the buttons that still apply.
 * Long values keep their start and end (the end of a command matters).
 */
export function renderPermissionPrompt(
  request: PermissionRequest,
  messages: Messages,
  actor?: SenderProfile,
  cause?: DecisionCause,
): RenderedPrompt {
  const status = statusLine(request, messages, actor, cause)
  const suffix = status === undefined ? '' : `\n\n${status}`
  const view = {
    requestId: request.id,
    toolName: elideMiddle(request.toolName, TOOL_NAME_BUDGET),
    description: elideMiddle(request.description, DESCRIPTION_BUDGET),
    inputPreview: '',
    risk: request.risk,
  }
  const fixed = messages.permissionPrompt(view).length + suffix.length
  const previewBudget = Math.max(MIN_PREVIEW_BUDGET, PROMPT_TEXT_BUDGET - fixed)
  const inputPreview = elideMiddle(request.inputPreview, previewBudget)
  return {
    text: messages.permissionPrompt({ ...view, inputPreview }) + suffix,
    keyboard: keyboardFor(request, messages),
  }
}

function keyboardFor(request: PermissionRequest, messages: Messages): PromptKeyboard {
  const button = (action: 'approve' | 'deny' | 'confirm' | 'cancel') => ({
    label: messages.permissionButtons[action],
    data: encodePermissionCallback(request.id, action),
  })
  switch (request.state) {
    case 'pending':
      return [[button('approve'), button('deny')]]
    case 'awaiting_confirmation':
      return [[button('confirm'), button('cancel')]]
    default:
      return []
  }
}

function statusLine(
  request: PermissionRequest,
  messages: Messages,
  actor: SenderProfile | undefined,
  cause: DecisionCause | undefined,
): string | undefined {
  const decision = () => ({
    who: actor === undefined ? (request.decidedBy ?? '?') : displayName(actor),
    at: new Date(request.decidedAt ?? 0).toISOString(),
  })
  switch (request.state) {
    case 'pending':
      return undefined
    case 'awaiting_confirmation':
      return messages.permissionAwaitingConfirmation(CONFIRMATION_WINDOW_MS / 1000)
    case 'approved':
      return messages.permissionApproved(decision())
    case 'denied':
      return cause === 'stop'
        ? messages.permissionDeniedByStop(decision())
        : messages.permissionDenied(decision())
    case 'expired':
      return messages.permissionExpired
    case 'resolved_locally':
      return messages.permissionResolvedLocally
  }
}

function displayName(sender: SenderProfile): string {
  return sender.username === undefined ? sender.displayName : `@${sender.username}`
}
