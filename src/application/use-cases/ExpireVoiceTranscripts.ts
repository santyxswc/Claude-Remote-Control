import type { VoiceTranscript } from '../../domain/voice/VoiceTranscript.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { VoiceTranscriptStore } from '../ports/VoiceTranscriptStore.ts'
import type { VoicePrompts } from '../voice/VoicePrompts.ts'

export interface ExpireVoiceTranscriptsDeps {
  readonly store: VoiceTranscriptStore
  readonly prompts: VoicePrompts
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
  readonly session: string
}

/** Time-driven upkeep of pending transcripts (F13): nothing is sent to the session. */
export class ExpireVoiceTranscripts {
  constructor(private readonly deps: ExpireVoiceTranscriptsDeps) {}

  /** This session's transcripts past the TTL expire and lose their buttons. */
  async execute(): Promise<number> {
    const now = this.deps.clock.now()
    let count = 0
    for (const transcript of this.deps.store.listPending()) {
      if (transcript.session !== this.deps.session || !transcript.isDue(now)) continue
      if (await this.#close(transcript, transcript.expire(now), 'ttl')) count += 1
    }
    return count
  }

  /** Transcripts of another channel process can no longer be sent from here (ADR 0007). */
  async expireOrphans(only?: ReadonlySet<string>): Promise<number> {
    const now = this.deps.clock.now()
    let count = 0
    for (const transcript of this.deps.store.listPending()) {
      if (
        transcript.session === this.deps.session ||
        (only !== undefined && !only.has(transcript.session))
      )
        continue
      if (await this.#close(transcript, transcript.cancel(now), 'orphaned')) count += 1
    }
    return count
  }

  async #close(
    stored: VoiceTranscript,
    next: VoiceTranscript,
    reason: 'ttl' | 'orphaned',
  ): Promise<boolean> {
    if (!this.deps.store.update(next, stored.revision)) return false
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: 'system',
      event: 'voice.expired',
      details: { transcriptId: stored.id, reason },
    })
    this.deps.logger.info('voice transcript closed without an answer', {
      transcriptId: stored.id,
      reason,
    })
    await this.deps.prompts.refresh(next, {
      status: next.state === 'expired' ? 'expired' : 'cancelled',
    })
    return true
  }
}
