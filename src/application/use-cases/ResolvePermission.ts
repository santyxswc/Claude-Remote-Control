import {
  InvalidPermissionTransitionError,
  type PermissionRequest,
} from '../../domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { PermissionAction } from '../permissions/callbackData.ts'
import type { PermissionOutcome } from '../permissions/PermissionOutcome.ts'
import type { PermissionPrompts } from '../permissions/PermissionPrompts.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PermissionStore } from '../ports/PermissionStore.ts'
import type { PermissionVerdictPort } from '../ports/PermissionVerdictPort.ts'
import type { AuthorizeSender } from './AuthorizeSender.ts'

/** A tap, a typed "yes/no <id>", or the denials of `/stop`. */
export type VerdictSource = 'button' | 'text' | 'stop'

export interface ResolvePermissionInput {
  readonly requestId: string
  readonly action: PermissionAction
  /** Who tapped or typed; checked against the allowlist again here. */
  readonly sender: SenderProfile
  /** A text verdict cannot give the second tap a high-risk approval needs. */
  readonly via: VerdictSource
}

export interface ResolvePermissionDeps {
  readonly store: PermissionStore
  readonly verdicts: PermissionVerdictPort
  readonly prompts: PermissionPrompts
  readonly authorize: AuthorizeSender
  /** While engaged nothing can be approved (the CLI's `stop` leaves prompts open). */
  readonly brake: BrakeFlag
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/**
 * Applies an answer from the chat. The decision is stored first
 * (compare-and-set, so a double tap or a racing expiry cannot produce two
 * verdicts), then the verdict is sent; if sending fails the request goes
 * back to pending. Every copy of the prompt is then updated.
 */
export class ResolvePermission {
  constructor(private readonly deps: ResolvePermissionDeps) {}

  async execute(input: ResolvePermissionInput): Promise<PermissionOutcome> {
    const { store, logger } = this.deps
    const { requestId, sender } = input
    if (!this.deps.authorize.execute(sender.id)) {
      logger.warn('permission answer from a sender who is not allowed', { senderId: sender.id })
      return 'not_allowed'
    }
    const stored = store.findById(requestId)
    if (stored === undefined || stored.session !== this.deps.session) return 'not_found'

    const now = this.deps.clock.now()
    const current = stored.settle(now)
    if (current.state === 'expired') return 'expired'
    if (!current.isOpen) return 'already_resolved'
    if (input.via === 'text' && input.action === 'approve' && current.risk === 'high') {
      return 'use_button'
    }
    if (
      (input.action === 'approve' || input.action === 'confirm') &&
      this.deps.brake.status().engaged
    ) {
      return 'braked'
    }

    let next: PermissionRequest
    try {
      next = this.#transition(current, input, now)
    } catch (error) {
      if (!(error instanceof InvalidPermissionTransitionError)) throw error
      const windowPassed = stored.state === 'awaiting_confirmation' && current.state === 'pending'
      if (!windowPassed) return 'invalid'
      // Confirm came too late: show Approve / Deny again.
      if (store.update(current, stored.revision)) await this.deps.prompts.refresh(current)
      return 'confirmation_expired'
    }
    if (!store.update(next, stored.revision)) {
      // Someone else changed it first; describe what it is now, and send nothing.
      const latest = store.findById(requestId)
      if (latest?.state === 'expired') return 'expired'
      return latest?.isOpen === true ? 'invalid' : 'already_resolved'
    }

    if (next.state === 'approved' || next.state === 'denied') {
      const delivered = await this.#deliver(next, sender, input.via)
      if (!delivered) return 'delivery_failed'
    } else if (next.state === 'awaiting_confirmation') {
      this.#audit('permission.confirmation_requested', next, sender, input.via)
    }
    await this.deps.prompts.refresh(next, sender, input.via === 'stop' ? 'stop' : undefined)
    return outcomeOf(next.state)
  }

  #transition(
    request: PermissionRequest,
    input: ResolvePermissionInput,
    now: number,
  ): PermissionRequest {
    const by = input.sender.id
    switch (input.action) {
      case 'approve':
        return request.approve(by, now)
      case 'confirm':
        return request.confirm(by, now)
      case 'deny':
        return request.deny(by, now)
      case 'cancel':
        return request.cancel(now)
    }
  }

  /** Sends the verdict; on failure, undoes the decision so nothing claims it was applied. */
  async #deliver(
    decided: PermissionRequest,
    sender: SenderProfile,
    via: VerdictSource,
  ): Promise<boolean> {
    const behavior = decided.state === 'approved' ? 'allow' : 'deny'
    try {
      await this.deps.verdicts.sendVerdict(decided.id, behavior)
    } catch (error) {
      this.deps.logger.error('could not send a permission verdict', {
        requestId: decided.id,
        error,
      })
      const reverted = decided.deliveryFailed()
      if (this.deps.store.update(reverted, decided.revision)) {
        await this.deps.prompts.refresh(reverted)
      }
      this.#audit('permission.verdict_failed', decided, sender, via, { behavior })
      return false
    }
    this.#audit(
      decided.state === 'approved' ? 'permission.approved' : 'permission.denied',
      decided,
      sender,
      via,
    )
    this.deps.logger.info('sent a permission verdict', { requestId: decided.id, behavior })
    return true
  }

  #audit(
    event:
      | 'permission.approved'
      | 'permission.denied'
      | 'permission.confirmation_requested'
      | 'permission.verdict_failed',
    request: PermissionRequest,
    sender: SenderProfile,
    via?: VerdictSource,
    extra: Record<string, string> = {},
  ): void {
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: `telegram:${sender.id}`,
      event,
      details: {
        requestId: request.id,
        toolName: request.toolName,
        risk: request.risk,
        ...(via === undefined ? {} : { via }),
        ...extra,
      },
    })
  }
}

function outcomeOf(state: PermissionRequest['state']): PermissionOutcome {
  switch (state) {
    case 'approved':
      return 'approved'
    case 'denied':
      return 'denied'
    case 'awaiting_confirmation':
      return 'confirmation_requested'
    default:
      return 'confirmation_cancelled'
  }
}
