/** Receives one authenticated hook payload (parsed JSON, not yet validated). */
export type HookPayloadHandler = (payload: unknown) => Promise<void>

/**
 * `listening`: hook events now arrive. `in_use`: another live process owns
 * the endpoint. `failed`: it could not be opened (logged by the adapter).
 */
export type HookListenResult = 'listening' | 'in_use' | 'failed'

/**
 * Where hook events come from: the hook entrypoint sends each one to the
 * running channel over local IPC. Never a network socket.
 */
export interface HookEventSource {
  start(handler: HookPayloadHandler): Promise<HookListenResult>
  /** Stops listening; safe to call when not listening. */
  stop(): Promise<void>
}
