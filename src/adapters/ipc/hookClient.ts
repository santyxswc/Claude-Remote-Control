import { connect } from 'node:net'
import type { HookEndpoint } from './endpoint.ts'
import { ACK } from './frame.ts'
import { isPrivateDir } from './privateDir.ts'

export type SendOutcome = 'acked' | 'unreachable' | 'no_ack'

/**
 * Sends one encoded frame and waits for the acknowledgement, at most
 * `timeoutMs`. Never throws: the caller exits 0 whatever happens.
 */
export function sendHookFrame(
  endpoint: HookEndpoint,
  frame: string,
  timeoutMs: number,
): Promise<SendOutcome> {
  // In a shared temp directory, only talk to a socket inside a directory that is ours alone.
  if (endpoint.kind === 'unix' && endpoint.privateDir !== undefined) {
    if (!isPrivateDir(endpoint.privateDir)) return Promise.resolve('unreachable')
  }
  return new Promise((resolve) => {
    let settled = false
    const socket = connect(endpoint.path)
    const finish = (outcome: SendOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(outcome)
    }
    const timer = setTimeout(() => finish('no_ack'), timeoutMs)
    socket.once('connect', () => socket.write(frame))
    socket.once('data', (data: Buffer) =>
      finish(data.toString('utf8') === ACK ? 'acked' : 'no_ack'),
    )
    socket.once('error', () => finish('unreachable'))
    socket.once('close', () => finish('no_ack'))
  })
}
