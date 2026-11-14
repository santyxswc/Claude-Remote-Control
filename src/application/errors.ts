/** Base class for expected application failures that the CLI turns into messages. */
export class ApplicationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The platform rejected the bot token (or it is malformed). Never carries the token. */
export class InvalidBotTokenError extends ApplicationError {
  constructor() {
    super('The bot token was rejected')
  }
}

/** The platform could not be reached to validate the token. */
export class BotUnreachableError extends ApplicationError {
  constructor(readonly detail: string) {
    super(`Could not reach the chat platform: ${detail}`)
  }
}

/** Another process changed the pairing between our read and our write. */
export class ConcurrentPairingUpdateError extends ApplicationError {
  constructor() {
    super('The pairing was changed by another process; try again')
  }
}

/** The terminal cannot do what was asked, e.g. read a secret without a TTY. */
export class TerminalUnavailableError extends ApplicationError {
  constructor() {
    super('No interactive terminal is available')
  }
}

/** A long message failed partway: the first `delivered` of `total` parts reached the chat. */
export class PartialDeliveryError extends ApplicationError {
  constructor(
    readonly delivered: number,
    readonly total: number,
    readonly failure: unknown,
  ) {
    const reason = failure instanceof Error ? failure.message : String(failure)
    super(`Delivered ${delivered} of ${total} parts; then: ${reason}`)
  }
}

/** The text is empty or only whitespace, which the chat platform refuses. */
export class EmptyMessageError extends ApplicationError {
  constructor() {
    super('The message has no visible text')
  }
}

export class PairingNotFoundError extends ApplicationError {
  constructor() {
    super('The pairing no longer exists')
  }
}
