import { DomainError } from './DomainError.ts'

/**
 * A chat-platform user id as a decimal string. Telegram user ids can exceed
 * 32 bits, so they are never handled as small integers.
 */
export type SenderId = string

const SENDER_ID = /^[1-9][0-9]{0,19}$/

export class InvalidSenderIdError extends DomainError {
  constructor() {
    super('A sender id must be a positive decimal integer')
  }
}

export function isSenderId(value: string): boolean {
  return SENDER_ID.test(value)
}

export function parseSenderId(raw: string): SenderId {
  const value = raw.trim()
  if (!isSenderId(value)) throw new InvalidSenderIdError()
  return value
}

/** Who sent a message, as reported by the chat platform. */
export interface SenderProfile {
  readonly id: SenderId
  /** Public handle without the leading `@`, if the user has one. */
  readonly username: string | undefined
  readonly displayName: string
}
