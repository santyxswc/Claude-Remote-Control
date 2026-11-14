import {
  isPermissionRequestId,
  PermissionRequest,
  type PromptRef,
} from '../../domain/permissions/PermissionRequest.ts'
import type { RiskPolicy } from '../../domain/permissions/RiskPolicy.ts'
import type { PermissionPrompts } from '../permissions/PermissionPrompts.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PermissionStore } from '../ports/PermissionStore.ts'

/** A permission prompt as Claude Code sends it. Every field is untrusted. */
export interface IncomingPermissionRequest {
  readonly requestId: string
  readonly toolName: string
  readonly description: string
  readonly inputPreview: string
}

export type RelayOutcome =
  | 'relayed'
  /** Not Claude Code's id format. */
  | 'invalid_id'
  /** This process cannot receive taps (another one polls the bot): nothing is sent. */
  | 'not_polling'
  /** The id is already in use; Claude Code drops verdicts for repeated ids. */
  | 'duplicate'

export interface RelayPermissionRequestDeps {
  readonly store: PermissionStore
  readonly prompts: PermissionPrompts
  readonly allowed: AllowedSenderStore
  readonly risk: RiskPolicy
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  /** Identifies this channel process; its verdicts only reach its own session. */
  readonly session: string
  /** True while this process polls the bot, i.e. can receive the taps. */
  readonly canRelay: () => boolean
}

/**
 * Records a permission request and posts it, with Approve / Deny buttons, to
 * every allowlisted sender. Whenever it cannot, nothing is sent and the
 * terminal dialog stays the only way to answer. Audit rows carry the tool
 * name and risk, never the description or the input.
 */
export class RelayPermissionRequest {
  constructor(private readonly deps: RelayPermissionRequestDeps) {}

  async execute(incoming: IncomingPermissionRequest): Promise<RelayOutcome> {
    const { store, logger, session } = this.deps
    const requestId = incoming.requestId
    if (!isPermissionRequestId(requestId)) {
      logger.warn('ignored a permission request with an invalid id')
      return 'invalid_id'
    }
    if (!this.deps.canRelay()) {
      logger.warn('not relaying a permission request: this process does not poll telegram', {
        requestId,
      })
      return 'not_polling'
    }
    const existing = store.findById(requestId)
    // A closed row of another (earlier) session is history; anything else is a real repeat.
    if (existing !== undefined && (existing.session === session || existing.isOpen)) {
      logger.warn('ignored a repeated permission request id', { requestId })
      return 'duplicate'
    }

    const now = this.deps.clock.now()
    const assessment = this.deps.risk.classify(incoming)
    const request = PermissionRequest.open({
      id: requestId,
      session,
      toolName: incoming.toolName,
      description: incoming.description,
      inputPreview: incoming.inputPreview,
      risk: assessment.level,
      now,
    })
    store.put(request)

    const recipients = this.deps.allowed.list().map((sender) => sender.id)
    const refs = await this.deps.prompts.send(request, recipients)
    const latest = this.#attachPrompts(request, refs)

    this.deps.audit.append({
      at: now,
      actor: 'session',
      event: 'permission.relayed',
      details: {
        requestId,
        toolName: incoming.toolName,
        risk: assessment.level,
        reasons: assessment.reasons.join(','),
        recipients: recipients.length,
        delivered: refs.length,
      },
    })
    logger.info('relayed a permission request', {
      requestId,
      risk: assessment.level,
      delivered: refs.length,
    })

    // Someone answered while the copies were going out: bring them up to date.
    if (latest !== undefined && latest.state !== 'pending') await this.deps.prompts.refresh(latest)
    return 'relayed'
  }

  /** Stores the message refs, retrying if a tap changed the request in between. */
  #attachPrompts(
    request: PermissionRequest,
    refs: readonly PromptRef[],
  ): PermissionRequest | undefined {
    if (refs.length === 0) return request
    let current: PermissionRequest | undefined = request
    while (current !== undefined) {
      const next = current.withPrompts(refs)
      if (this.deps.store.update(next, current.revision)) return next
      current = this.deps.store.findById(request.id)
    }
    return undefined
  }
}
