/** The CLI's view of the user's terminal, so commands can be tested without a TTY. */
export interface Terminal {
  print(line: string): void
  /** For errors; goes to stderr. */
  error(line: string): void
  ask(prompt: string): Promise<string>
  /** Reads a line without echoing it. Rejects when there is no interactive terminal. */
  askSecret(prompt: string): Promise<string>
  confirm(prompt: string): Promise<boolean>
  /** Reads everything piped to stdin (for `--token-stdin`). */
  readPipedInput(): Promise<string>
}
