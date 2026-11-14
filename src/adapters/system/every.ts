/** Runs `task` every `ms`; returns a function that cancels it. Injected so tests drive time. */
export type Every = (ms: number, task: () => void) => () => void

/** `setInterval` that never keeps the process alive on its own. */
export const realEvery: Every = (ms, task) => {
  const timer = setInterval(task, ms)
  timer.unref()
  return () => clearInterval(timer)
}
