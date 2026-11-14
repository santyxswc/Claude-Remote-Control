import { isChoiceId, MAX_CHOICE_OPTIONS } from '../../domain/choices/Choice.ts'

/** An option by its position, or "Other...". */
export type ChoicePick = number | 'other'

/**
 * Version 1 of choice button data: `c1:<choice id>:<0-7 | o>`, 15 bytes.
 * A different prefix from permissions (`p1:`), and both parsers are anchored,
 * so a choice button can never be read as a permission answer or vice versa.
 */
const CALLBACK_DATA = /^c1:([a-z2-7]{10}):([0-7]|o)$/

export interface ChoiceCallback {
  readonly choiceId: string
  readonly pick: ChoicePick
}

export function encodeChoiceCallback(choiceId: string, pick: ChoicePick): string {
  if (!isChoiceId(choiceId)) throw new Error('invalid choice id')
  if (pick !== 'other' && !(Number.isInteger(pick) && pick >= 0 && pick < MAX_CHOICE_OPTIONS)) {
    throw new Error('invalid choice option')
  }
  return `c1:${choiceId}:${pick === 'other' ? 'o' : pick}`
}

/** Strict: anything that is not exactly what we encode is rejected. */
export function parseChoiceCallback(data: string | undefined): ChoiceCallback | undefined {
  const match = CALLBACK_DATA.exec(data ?? '')
  const choiceId = match?.[1]
  const pick = match?.[2]
  if (choiceId === undefined || pick === undefined) return undefined
  return { choiceId, pick: pick === 'o' ? 'other' : Number(pick) }
}
