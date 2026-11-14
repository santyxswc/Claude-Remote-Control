/** Waits between polls; tests replace it with one that advances a fake clock. */
export interface Sleeper {
  sleep(ms: number): Promise<void>
}
