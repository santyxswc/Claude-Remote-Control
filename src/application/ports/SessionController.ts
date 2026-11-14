/**
 * - `sent`: an interrupt keystroke was delivered to the session's terminal
 *   (not a confirmation that Claude stopped).
 * - `unavailable`: no way to reach the terminal on this platform or setup.
 * - `failed`: there was a way, but it did not work this time.
 */
export type InterruptResult = 'sent' | 'unavailable' | 'failed'

/**
 * Best-effort interruption of the running turn (GoF Strategy: tmux where the
 * channel runs inside it, nothing elsewhere). The PreToolUse brake is the
 * guarantee; this only cuts text generation that would otherwise continue.
 */
export interface SessionController {
  /** Never rejects. */
  interrupt(): Promise<InterruptResult>
}
