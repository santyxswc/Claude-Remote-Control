import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import type { VoiceTranscript } from '../../domain/voice/VoiceTranscript.ts'
import { PromptTooLongError } from '../errors.ts'
import type { Messages, VoiceStatusView } from '../i18n/messages.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PromptGateway, PromptKeyboard } from '../ports/PromptGateway.ts'
import { encodeVoiceCallback } from './voiceCallbackData.ts'

export function voiceKeyboard(transcript: VoiceTranscript, messages: Messages): PromptKeyboard {
  if (!transcript.isPending) return []
  return [
    [
      { label: messages.voiceButtons.send, data: encodeVoiceCallback(transcript.id, 'send') },
      { label: messages.voiceButtons.discard, data: encodeVoiceCallback(transcript.id, 'discard') },
    ],
  ]
}

/**
 * Shows a voice transcript with Send and Discard, and keeps its message in
 * step with its state. The prompt must show exactly what Send delivers: it is
 * sent with `overflow: 'refuse'` and `redaction: 'refuse'`, so a transcript
 * that would be cut or have text replaced is never offered (the caller
 * discards it and says why).
 */
export class VoicePrompts {
  constructor(
    /** The redacting decorator from `buildOutbound`. */
    private readonly gateway: PromptGateway,
    private readonly messages: Messages,
    private readonly logger: Logger,
  ) {}

  /** Rejects with `PromptRedactedError` or `PromptTooLongError`, or when not delivered. */
  send(transcript: VoiceTranscript): Promise<PromptRef> {
    return this.gateway.sendPrompt(
      transcript.chatId,
      this.#body(transcript),
      voiceKeyboard(transcript, this.messages),
      { overflow: 'refuse', redaction: 'refuse' },
    )
  }

  /** Shows how it ended under the text and removes the buttons. */
  async refresh(
    transcript: VoiceTranscript,
    status: VoiceStatusView,
    ref: PromptRef | undefined = transcript.prompt,
  ): Promise<void> {
    if (ref === undefined) return
    const keyboard = voiceKeyboard(transcript, this.messages)
    const line = this.messages.voiceStatus(status)
    try {
      // A closed row read back from the store no longer has its text.
      if (transcript.text === '') {
        await this.gateway.editPrompt(ref, line, keyboard)
        return
      }
      try {
        await this.gateway.editPrompt(ref, `${this.#body(transcript)}\n\n${line}`, keyboard, {
          overflow: 'refuse',
        })
      } catch (error) {
        if (!(error instanceof PromptTooLongError)) throw error
        await this.gateway.editPrompt(ref, line, keyboard)
      }
    } catch (error) {
      this.logger.warn('could not update a voice transcript message', {
        transcriptId: transcript.id,
        error,
      })
    }
  }

  #body(transcript: VoiceTranscript): string {
    return this.messages.voicePrompt({
      text: transcript.text,
      seconds: transcript.durationSeconds,
    })
  }
}
