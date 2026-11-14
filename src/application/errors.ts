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

/** A prompt does not fit one message once redacted; the caller sends its details first (M2). */
export class PromptTooLongError extends ApplicationError {
  constructor(readonly length: number) {
    super(`The prompt is ${length} characters long once redacted`)
  }
}

/** Why a chart could not be drawn (F11). `detail` is the renderer's message, for Claude only. */
export type ChartRenderFailure = 'invalid_spec' | 'too_big' | 'timeout' | 'failed'

/** The chart renderer refused or failed. Never logged with `detail` (it may quote the spec). */
export class ChartRenderError extends ApplicationError {
  constructor(
    readonly reason: ChartRenderFailure,
    readonly detail?: string,
  ) {
    super(`The chart could not be rendered (${reason})`)
  }
}

/**
 * A prompt sent with `redaction: 'refuse'` would have had text replaced (F12):
 * the owner would not see what is being approved.
 */
export class PromptRedactedError extends ApplicationError {
  constructor(readonly count: number) {
    super(`The prompt contains ${count} secret-like value(s)`)
  }
}

/** Why a voice note could not be transcribed (F13). */
export type TranscriptionFailure =
  /** ffmpeg could not read the note or write the WAV. */
  | 'conversion_failed'
  /** whisper.cpp exited with an error or wrote no transcript. */
  | 'transcription_failed'
  /** A program ran past its deadline and was killed. */
  | 'timeout'
  /** A program wrote more than the bridge reads. */
  | 'output_too_large'
  | 'cancelled'

/** The transcriber failed. Never carries the transcript or the audio. */
export class TranscriptionError extends ApplicationError {
  constructor(readonly reason: TranscriptionFailure) {
    super(`The voice note could not be transcribed (${reason})`)
  }
}

/** Why a file in the project could not be written (F12). Never carries file contents. */
export type ProjectFileProblem =
  | 'outside_project'
  | 'not_a_regular_file'
  | 'too_large'
  | 'changed_meanwhile'
  | 'no_free_name'
  | 'io'

export class ProjectFileError extends ApplicationError {
  constructor(readonly problem: ProjectFileProblem) {
    super(`The project file could not be written (${problem})`)
  }
}
