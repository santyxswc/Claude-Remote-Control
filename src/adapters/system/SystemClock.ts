import type { Clock } from '../../application/ports/Clock.ts'

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}
