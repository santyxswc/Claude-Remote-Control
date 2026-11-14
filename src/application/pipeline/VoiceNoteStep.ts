import type { ReceiveVoiceNote } from '../use-cases/ReceiveVoiceNote.ts'
import type { InboundMessage } from './InboundMessage.ts'
import type { InboundHandler, InboundStep } from './InboundStep.ts'

/**
 * After the brake gate (F13): a voice note is handed to the transcription in
 * the background, so a slow transcription never holds up the chat or `/stop`
 * (which has a lane of its own anyway). Nothing reaches the session from
 * here: the transcript is shown to the owner, who decides with Send.
 */
export class VoiceNoteStep implements InboundStep {
  constructor(private readonly receive: Pick<ReceiveVoiceNote, 'start'>) {}

  async handle(message: InboundMessage, next: InboundHandler): Promise<void> {
    if (message.voice === undefined || message.sender === undefined) {
      await next(message)
      return
    }
    this.receive.start({ ...message, sender: message.sender, voice: message.voice })
  }
}
