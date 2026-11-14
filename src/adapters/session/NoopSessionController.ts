import type {
  InterruptResult,
  SessionController,
} from '../../application/ports/SessionController.ts'

/** Where no terminal can be reached (Windows, or anywhere outside tmux). */
export class NoopSessionController implements SessionController {
  async interrupt(): Promise<InterruptResult> {
    return 'unavailable'
  }
}
