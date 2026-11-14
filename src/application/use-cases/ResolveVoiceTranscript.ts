import { senderLabel } from '../../domain/displayText.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { SenderProfile } from '../../domain/Sender.ts'
import type { VoiceTranscript } from '../../domain/voice/VoiceTranscript.ts'
import type { VoiceTapOutcome } from '../i18n/messages.ts'
import type { InboundHandler } from '../pipeline/InboundStep.ts'
import type { AuditEvent, AuditLog } from '../ports/AuditLog.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { VoiceTranscriptStore } from '../ports/VoiceTranscriptStore.ts'
import type { VoicePrompts } from '../voice/VoicePrompts.ts'
import type { VoiceAction } from '../voice/voiceCallbackData.ts'
import type { AuthorizeSender } from './AuthorizeSender.ts'

export interface ResolveVoiceInput {
  readonly transcriptId: string
  readonly action: VoiceAction
  /** Who tapped; checked against the allowlist again here. */
  readonly sender: SenderProfile
  /** The tapped message's chat and id; the chat must be the one the transcript was shown in. */
  readonly chatId: string
  readonly messageId: string | undefined
}

export interface ResolveVoiceDeps {
  readonly store: VoiceTranscriptStore
  readonly prompts: VoicePrompts
  /**
   * The transcript chain (`createTranscriptSteps`): rate limit, brake gate,
   * typed choice answers and delivery, as typed text, but never the commands
   * or the permission verdicts.
   */
  readonly deliver: InboundHandler
  readonly authorize: AuthorizeSender
  readonly brake: Pick<BrakeFlag, 'status'>
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/**
 * A tap on Send or Discard under a voice transcript (F13). Send claims the
 * transcript with compare-and-set and feeds exactly the text shown into the
 * transcript chain as text from the owner, tagged `kind="voice"`; Discard
 * drops it. While the brake is engaged Send changes nothing and gets the
 * brake toast, so it can be sent after `/resume`. A second tap only gets a
 * toast. Audit rows carry ids and counts, never the text.
 */
export class ResolveVoiceTranscript {
  constructor(private readonly deps: ResolveVoiceDeps) {}

  async execute(input: ResolveVoiceInput): Promise<VoiceTapOutcome> {
    const { store, logger } = this.deps
    const { sender } = input
    if (!this.deps.authorize.execute(sender.id)) {
      logger.warn('voice tap from a sender who is not allowed', { senderId: sender.id })
      return 'not_allowed'
    }
    const stored = store.findById(input.transcriptId)
    if (
      stored === undefined ||
      stored.session !== this.deps.session ||
      stored.chatId !== input.chatId
    ) {
      return 'not_found'
    }
    const ref: PromptRef | undefined =
      stored.prompt ??
      (input.messageId === undefined
        ? undefined
        : { chatId: input.chatId, messageId: input.messageId })
    const now = this.deps.clock.now()
    if (stored.isDue(now)) {
      const expired = stored.expire(now)
      if (store.update(expired, stored.revision)) {
        this.#audit('voice.expired', sender, { transcriptId: stored.id, reason: 'ttl' })
        await this.deps.prompts.refresh(expired, { status: 'expired' }, ref)
      }
      return 'expired'
    }
    const closed = closedOutcome(stored)
    if (closed !== undefined) return closed
    return input.action === 'send'
      ? this.#send(stored, sender, now, ref)
      : this.#discard(stored, sender, now, ref)
  }

  async #send(
    stored: VoiceTranscript,
    sender: SenderProfile,
    now: number,
    ref: PromptRef | undefined,
  ): Promise<VoiceTapOutcome> {
    if (this.deps.brake.status().engaged) return 'braked'
    const next = stored.send(sender.id, now)
    if (!this.deps.store.update(next, stored.revision)) return this.#raced(stored.id)
    this.#audit('voice.sent', sender, { transcriptId: stored.id, characters: stored.length })
    this.deps.logger.info('voice transcript sent', { transcriptId: stored.id })
    await this.deps.deliver({
      chatId: stored.chatId,
      messageId: stored.prompt?.messageId ?? ref?.messageId ?? '0',
      chatKind: 'private',
      sender,
      text: stored.text,
      sentAt: now,
      forwardContext: { kind: 'voice', transcriptId: stored.id },
    })
    await this.deps.prompts.refresh(
      next,
      { status: 'sent', who: senderLabel(sender), at: new Date(now).toISOString() },
      ref,
    )
    return 'sent'
  }

  async #discard(
    stored: VoiceTranscript,
    sender: SenderProfile,
    now: number,
    ref: PromptRef | undefined,
  ): Promise<VoiceTapOutcome> {
    const next = stored.discard(sender.id, now)
    if (!this.deps.store.update(next, stored.revision)) return this.#raced(stored.id)
    this.#audit('voice.discarded', sender, { transcriptId: stored.id, characters: stored.length })
    await this.deps.prompts.refresh(
      next,
      { status: 'discarded', who: senderLabel(sender), at: new Date(now).toISOString() },
      ref,
    )
    return 'discarded'
  }

  /** Someone else changed it first; describe what it is now. */
  #raced(transcriptId: string): VoiceTapOutcome {
    const latest = this.deps.store.findById(transcriptId)
    return latest === undefined ? 'not_found' : (closedOutcome(latest) ?? 'already_resolved')
  }

  #audit(event: AuditEvent, sender: SenderProfile, details: Record<string, string | number>): void {
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: `telegram:${sender.id}`,
      event,
      details,
    })
  }
}

function closedOutcome(transcript: VoiceTranscript): VoiceTapOutcome | undefined {
  switch (transcript.state) {
    case 'pending':
      return undefined
    case 'sent':
    case 'discarded':
      return 'already_resolved'
    case 'expired':
      return 'expired'
    case 'cancelled':
      return 'not_found'
  }
}
