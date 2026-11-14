import { senderLabel } from '../../domain/displayText.ts'
import {
  CONFIRMATION_WINDOW_MS,
  type PermissionRequest,
} from '../../domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { Messages } from '../i18n/messages.ts'
import type { PromptKeyboard } from '../ports/PromptGateway.ts'
import { encodePermissionCallback } from './callbackData.ts'

/** How a decision was reached, when the state alone does not say it (a `/stop`). */
export type DecisionCause = 'stop'

export interface RenderedPrompt {
  /** The whole prompt, nothing elided: the redacting gateway fits it after redaction (M3). */
  readonly text: string
  /** The same prompt with the description and input replaced by "they are above" (M2). */
  readonly compact: string
  /** The whole description and input, for the plain message(s) sent before `compact`. */
  readonly details: string
  readonly keyboard: PromptKeyboard
}

/**
 * The prompt as it should look in the request's current state: content,
 * a status line once something happened, and the buttons that still apply.
 * Nothing is cut here: cutting before redaction could leave half a secret
 * that no detector recognizes (M3), and a cut must never be silent (M2).
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
    toolName: request.toolName,
    description: request.description,
    inputPreview: request.inputPreview,
    risk: request.risk,
  }
  return {
    text: messages.permissionPrompt(view) + suffix,
    compact:
      messages.permissionPrompt({
        ...view,
        description: messages.permissionDetailsAbove,
        inputPreview: '',
      }) + suffix,
    details: messages.permissionDetails(view),
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
    who: actor === undefined ? (request.decidedBy ?? '?') : senderLabel(actor),
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
