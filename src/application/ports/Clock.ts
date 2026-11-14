/** Wall-clock time, injected so expiry can be tested without sleeping. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number
}
