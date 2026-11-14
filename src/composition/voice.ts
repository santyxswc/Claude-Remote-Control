/**
 * Wires F13: voice notes downloaded through the F10 source into a private
 * scratch directory, transcribed locally, and shown with Send and Discard.
 * Transcripts are scoped to this process's session (like choices, ADR 0007).
 * A confirmed transcript runs the transcript chain, never the commands.
 */
import type { StateStores } from '../adapters/storage/openState.ts'
import { CryptoRandomSource } from '../adapters/system/CryptoRandomSource.ts'
import { TelegramAttachmentSource } from '../adapters/telegram/TelegramAttachmentSource.ts'
import { FileAudioScratch } from '../adapters/voice/FileAudioScratch.ts'
import type { Messages } from '../application/i18n/messages.ts'
import type { InboundHandler } from '../application/pipeline/InboundStep.ts'
import type { AttachmentSource } from '../application/ports/AttachmentSource.ts'
import type { ChatGateway } from '../application/ports/ChatGateway.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { Logger } from '../application/ports/Logger.ts'
import type { PromptGateway } from '../application/ports/PromptGateway.ts'
import type { Transcriber } from '../application/ports/Transcriber.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { ExpireVoiceTranscripts } from '../application/use-cases/ExpireVoiceTranscripts.ts'
import { ReceiveVoiceNote } from '../application/use-cases/ReceiveVoiceNote.ts'
import { ResolveVoiceTranscript } from '../application/use-cases/ResolveVoiceTranscript.ts'
import { VoicePrompts } from '../application/voice/VoicePrompts.ts'
import { MAX_VOICE_BYTES } from '../domain/voice/voiceNote.ts'

export interface VoiceWiringDeps {
  readonly stateDir: string
  readonly session: string
  readonly token: string
  readonly transcriber: Transcriber
  readonly state: Pick<StateStores, 'voiceTranscripts' | 'allowed' | 'audit' | 'brake'>
  /** The decorated gateway from `buildOutbound`. */
  readonly outbound: ChatGateway & PromptGateway
  readonly messages: Messages
  /** `TELEGRAM_BRIDGE_MAX_UPLOAD_MB` can only lower the voice cap. */
  readonly maxUploadBytes: number
  readonly clock: Clock
  readonly logger: Logger
  /** F14, a spoke: downloads go through the hub; Telegram otherwise. */
  readonly source?: AttachmentSource
  /** Test seam for the downloads. */
  readonly fetch?: typeof fetch
}

export interface VoiceWiring {
  readonly receive: ReceiveVoiceNote
  readonly expire: ExpireVoiceTranscripts
  /** Send and Discard; `deliver` is the transcript chain (`createTranscriptSteps`). */
  resolve(deliver: InboundHandler): ResolveVoiceTranscript
  /** Removes workspaces a crashed process left behind. */
  sweepScratch(): Promise<number>
}

export function buildVoice(deps: VoiceWiringDeps): VoiceWiring {
  const { state, messages, clock, logger, session } = deps
  const store = state.voiceTranscripts
  const prompts = new VoicePrompts(deps.outbound, messages, logger)
  // File times are wall-clock times, so the sweep compares them with the real clock.
  const scratch = new FileAudioScratch(deps.stateDir, logger)
  const common = { store, prompts, audit: state.audit, clock, logger, session }
  return {
    receive: new ReceiveVoiceNote({
      ...common,
      transcriber: deps.transcriber,
      scratch,
      source:
        deps.source ??
        new TelegramAttachmentSource(deps.token, {
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        }),
      chat: deps.outbound,
      messages,
      random: new CryptoRandomSource(),
      maxBytes: Math.min(MAX_VOICE_BYTES, deps.maxUploadBytes),
    }),
    expire: new ExpireVoiceTranscripts(common),
    resolve: (deliver) =>
      new ResolveVoiceTranscript({
        ...common,
        deliver,
        authorize: new AuthorizeSender(state.allowed),
        brake: state.brake,
      }),
    sweepScratch: () => scratch.sweep(),
  }
}
