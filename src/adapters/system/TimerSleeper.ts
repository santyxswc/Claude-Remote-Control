import type { Sleeper } from '../../application/ports/Sleeper.ts'

export class TimerSleeper implements Sleeper {
  sleep(ms: number): Promise<void> {
    return Bun.sleep(ms)
  }
}
