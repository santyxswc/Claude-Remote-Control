/**
 * End-to-end check of the hook entrypoint: spawns `bun src/hook.ts <Event>`
 * the way Claude Code does (JSON on stdin) against a real listener. Whatever
 * happens it must exit 0, print nothing on stdout and finish fast.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { hookEndpoint } from '../src/adapters/ipc/endpoint.ts'
import { HookIpcServer } from '../src/adapters/ipc/HookIpcServer.ts'
import { loadOrCreateHookSecret } from '../src/adapters/ipc/hookSecret.ts'
import { MemoryLogger, SequentialRandom } from './fakes.ts'
import { makeTempDir, removeTempDir } from './tempDir.ts'

const HOOK = join(import.meta.dir, '..', 'src', 'hook.ts')
/** Generous for a loaded CI runner; locally a run takes about 40 ms. */
const FAST_MS = 1_200

let stateDir: string
let server: HookIpcServer | undefined

beforeEach(() => {
  stateDir = makeTempDir()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  removeTempDir(stateDir)
})

async function runHook(args: string[], stdin: string, extraEnv: Record<string, string> = {}) {
  const started = performance.now()
  const child = Bun.spawn([process.execPath, HOOK, ...args], {
    env: { ...process.env, TELEGRAM_BRIDGE_HOME: stateDir, ...extraEnv },
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr, ms: performance.now() - started }
}

async function listen(): Promise<unknown[]> {
  const received: unknown[] = []
  server = new HookIpcServer({
    endpoint: hookEndpoint(stateDir),
    secret: loadOrCreateHookSecret(stateDir, new SequentialRandom()),
    logger: new MemoryLogger(),
  })
  expect(await server.start(async (payload) => void received.push(payload))).toBe('listening')
  return received
}

const stopEvent = JSON.stringify({
  session_id: 'abc',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/home/me/app',
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'All tests pass.',
})

test('happy path: the event reaches the listener; exit 0, empty stdout', async () => {
  const received = await listen()
  const result = await runHook(['Stop'], stopEvent)
  expect(result).toMatchObject({ exitCode: 0, stdout: '', stderr: '' })
  expect(result.ms).toBeLessThan(FAST_MS)
  expect(received).toEqual([
    {
      hook_event_name: 'Stop',
      session_id: 'abc',
      cwd: '/home/me/app',
      last_assistant_message: 'All tests pass.',
    },
  ])
})

test('nobody listening (bridge configured but not running): exit 0, empty stdout, fast', async () => {
  loadOrCreateHookSecret(stateDir, new SequentialRandom())
  const result = await runHook(['Stop'], stopEvent, { TELEGRAM_BRIDGE_DEBUG: '1' })
  expect(result).toMatchObject({ exitCode: 0, stdout: '' })
  expect(result.ms).toBeLessThan(FAST_MS)
  expect(result.stderr).toContain('Stop: unreachable')
})

test('bridge never ran here (no secret): exit 0, empty stdout, nothing created', async () => {
  const result = await runHook(['Notification'], '{}', { TELEGRAM_BRIDGE_DEBUG: '1' })
  expect(result).toMatchObject({ exitCode: 0, stdout: '' })
  expect(result.stderr).toContain('no hook secret')
  expect(Array.from(new Bun.Glob('*').scanSync(stateDir))).toEqual([])
})

test('odd input never breaks the session: unknown event, no event, garbage stdin', async () => {
  const received = await listen()
  for (const [args, stdin] of [
    [['SessionStart'], '{}'],
    [[], '{}'],
    [['Stop'], 'not json'],
    [['Stop'], ''],
  ] as const) {
    const result = await runHook([...args], stdin)
    expect(result).toMatchObject({ exitCode: 0, stdout: '', stderr: '' })
  }
  expect(received).toEqual([])
})

test('diagnostics only with TELEGRAM_BRIDGE_DEBUG=1, and only on stderr', async () => {
  await listen()
  const quiet = await runHook(['UserPromptSubmit'], '{"prompt":"secret prompt"}')
  expect(quiet.stderr).toBe('')
  const loud = await runHook(['UserPromptSubmit'], '{"prompt":"secret prompt"}', {
    TELEGRAM_BRIDGE_DEBUG: '1',
  })
  expect(loud.stdout).toBe('')
  expect(loud.stderr).toContain('UserPromptSubmit: acked')
  expect(loud.stderr).not.toContain('secret prompt')
})

test('a listener that never answers cannot hold the hook past its deadline', async () => {
  loadOrCreateHookSecret(stateDir, new SequentialRandom())
  // Accepts connections but never acknowledges.
  const { createServer } = await import('node:net')
  const sockets: import('node:net').Socket[] = []
  const silent = createServer((socket) => void sockets.push(socket))
  const path = hookEndpoint(stateDir).path
  await new Promise<void>((resolve) => silent.listen(path, () => resolve()))
  try {
    const result = await runHook(['Stop'], stopEvent, { TELEGRAM_BRIDGE_DEBUG: '1' })
    expect(result).toMatchObject({ exitCode: 0, stdout: '' })
    expect(result.stderr).toContain('Stop: no_ack')
    expect(result.ms).toBeLessThan(2_500)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => silent.close(() => resolve()))
  }
})
