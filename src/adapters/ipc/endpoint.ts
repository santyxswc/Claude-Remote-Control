import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'

/**
 * Where the channel listens for hook events. Never a network address.
 * - `pipe`: a Windows named pipe.
 * - `unix`: a Unix domain socket. `privateDir` is set when the socket is not
 *   inside the state directory: that directory must exist, be ours and be 0700.
 */
export type HookEndpoint =
  | { readonly kind: 'pipe'; readonly path: string }
  | { readonly kind: 'unix'; readonly path: string; readonly privateDir: string | undefined }

export const SOCKET_FILE = 'hooks.sock'

const RUNTIME_DIR_ENV = 'XDG_RUNTIME_DIR'

/** `sun_path` holds 104 bytes on macOS and 108 on Linux, including the terminator. */
export const MAX_SOCKET_PATH_BYTES = 100

export interface EndpointContext {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly tmpDir: string
}

const processContext = (): EndpointContext => ({
  platform: process.platform,
  env: process.env,
  tmpDir: tmpdir(),
})

/**
 * The endpoint for a state directory; the channel and the hook entrypoint
 * derive the same one from the same directory. Pure given the context.
 */
export function hookEndpoint(stateDir: string, context = processContext()): HookEndpoint {
  return localEndpoint(stateDir, SOCKET_FILE, 'telegram-bridge', context)
}

/** F14: where the hub listens for spokes. Same rules as the hook endpoint, another name. */
export const HUB_SOCKET_FILE = 'hub.sock'

export function hubEndpoint(stateDir: string, context = processContext()): HookEndpoint {
  return localEndpoint(stateDir, HUB_SOCKET_FILE, 'telegram-bridge-hub', context)
}

function localEndpoint(
  stateDir: string,
  socketFile: string,
  pipePrefix: string,
  context: EndpointContext,
): HookEndpoint {
  const id = stateDirHash(stateDir, context.platform)
  if (context.platform === 'win32') {
    return { kind: 'pipe', path: `\\\\.\\pipe\\${pipePrefix}-${id}` }
  }
  // Only reached off Windows, where paths are POSIX paths.
  const { isAbsolute, join } = posix
  const inState = join(stateDir, socketFile)
  if (Buffer.byteLength(inState) <= MAX_SOCKET_PATH_BYTES) {
    return { kind: 'unix', path: inState, privateDir: undefined }
  }
  // Too long for sun_path: a short private directory, named after the state directory.
  const runtime = context.env[RUNTIME_DIR_ENV]
  const base = runtime !== undefined && isAbsolute(runtime) ? runtime : context.tmpDir
  const privateDir = join(base, `telegram-bridge-${id}`)
  return { kind: 'unix', path: join(privateDir, socketFile), privateDir }
}

function stateDirHash(stateDir: string, platform: NodeJS.Platform): string {
  // Windows paths are case-insensitive: the same directory must give the same pipe.
  const key = platform === 'win32' ? stateDir.toLowerCase() : stateDir
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}
