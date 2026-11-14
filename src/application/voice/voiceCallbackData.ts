import { isVoiceTranscriptId } from '../../domain/voice/VoiceTranscript.ts'

export type VoiceAction = 'send' | 'discard'

export interface VoiceCallback {
  readonly transcriptId: string
  readonly action: VoiceAction
}

/**
 * Version 1 of voice transcript button data: `v1:<transcript id>:<s|d>`, 15
 * bytes. Its own prefix, and every parser is anchored, so a voice button can
 * never be read as a permission (`p1:`), choice (`c1:`), skill (`k1:`), git
 * (`g1:`) or memory (`m1:`) button, nor the other way round.
 */
const CALLBACK_DATA = /^v1:([a-z2-7]{10}):([sd])$/

export function encodeVoiceCallback(transcriptId: string, action: VoiceAction): string {
  if (!isVoiceTranscriptId(transcriptId)) throw new Error('invalid voice transcript id')
  return `v1:${transcriptId}:${action === 'send' ? 's' : 'd'}`
}

/** Strict: anything that is not exactly what we encode is rejected. */
export function parseVoiceCallback(data: string | undefined): VoiceCallback | undefined {
  const match = CALLBACK_DATA.exec(data ?? '')
  const transcriptId = match?.[1]
  const action = match?.[2]
  if (transcriptId === undefined || action === undefined) return undefined
  return { transcriptId, action: action === 's' ? 'send' : 'discard' }
}
