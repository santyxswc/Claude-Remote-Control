/** Pure pieces of the hook IPC: endpoint naming, framing, payload projection, the secret file. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hookEndpoint,
  MAX_SOCKET_PATH_BYTES,
  SOCKET_FILE,
} from '../../../src/adapters/ipc/endpoint.ts'
import { encodeFrame, MAX_FRAME_BYTES, verifyFrame } from '../../../src/adapters/ipc/frame.ts'
import { projectHookPayload } from '../../../src/adapters/ipc/hookPayload.ts'
import {
  HOOK_SECRET_FILE,
  loadOrCreateHookSecret,
  readHookSecret,
} from '../../../src/adapters/ipc/hookSecret.ts'
import { SequentialRandom } from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

describe('endpoint', () => {
  const linux = { platform: 'linux' as const, env: {}, tmpDir: '/tmp' }

  test('Windows: a named pipe derived from the state directory, case-insensitively', () => {
    const win = { platform: 'win32' as const, env: {}, tmpDir: 'C:\\Temp' }
    const a = hookEndpoint('C:\\Users\\Me\\.claude\\channels\\telegram-bridge', win)
    const b = hookEndpoint('c:\\users\\me\\.claude\\channels\\telegram-bridge', win)
    expect(a.kind).toBe('pipe')
    expect(a.path).toMatch(/^\\\\\.\\pipe\\telegram-bridge-[0-9a-f]{16}$/)
    expect(b.path).toBe(a.path)
    expect(hookEndpoint('C:\\other', win).path).not.toBe(a.path)
  })

  test('POSIX: a socket inside the state directory when the path fits', () => {
    expect(hookEndpoint('/home/me/.claude/channels/telegram-bridge', linux)).toEqual({
      kind: 'unix',
      path: `/home/me/.claude/channels/telegram-bridge/${SOCKET_FILE}`,
      privateDir: undefined,
    })
  })

  test('POSIX: a too-long state directory falls back to a short private directory', () => {
    const long = `/home/me/${'deep/'.repeat(30)}state`
    const viaTmp = hookEndpoint(long, linux)
    expect(viaTmp.kind).toBe('unix')
    if (viaTmp.kind !== 'unix') return
    expect(viaTmp.privateDir).toMatch(/^\/tmp\/telegram-bridge-[0-9a-f]{16}$/)
    expect(viaTmp.path).toBe(`${viaTmp.privateDir}/${SOCKET_FILE}`)
    expect(Buffer.byteLength(viaTmp.path)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES)

    const viaRuntime = hookEndpoint(long, { ...linux, env: { XDG_RUNTIME_DIR: '/run/user/1000' } })
    expect(viaRuntime.path.startsWith('/run/user/1000/telegram-bridge-')).toBe(true)
    // A relative runtime dir is not trusted.
    const relative = hookEndpoint(long, { ...linux, env: { XDG_RUNTIME_DIR: 'run' } })
    expect(relative.path.startsWith('/tmp/')).toBe(true)
  })
})

describe('frame', () => {
  const secret = new Uint8Array(32).fill(7)
  const other = new Uint8Array(32).fill(8)

  test('round trip, one newline-terminated line', () => {
    const json = JSON.stringify({ hook_event_name: 'Stop', text: 'line1\nline2' })
    const frame = encodeFrame(secret, json)
    expect(frame.endsWith('\n')).toBe(true)
    expect(frame.indexOf('\n')).toBe(frame.length - 1)
    expect(verifyFrame(secret, frame.slice(0, -1))).toBe(json)
  })

  test('the secret is not on the wire', () => {
    const frame = encodeFrame(secret, '{}')
    expect(frame).not.toContain(Buffer.from(secret).toString('hex'))
    expect(frame).not.toContain(Buffer.from(secret).toString('base64url'))
  })

  test('rejects a wrong secret, tampering, other versions and garbage', () => {
    const line = encodeFrame(secret, '{"a":1}').slice(0, -1)
    expect(verifyFrame(other, line)).toBeUndefined()
    expect(verifyFrame(secret, line.replace('"a":1', '"a":2'))).toBeUndefined()
    expect(verifyFrame(secret, line.replace(/^tb1/, 'tb2'))).toBeUndefined()
    expect(verifyFrame(secret, 'tb1 short {}')).toBeUndefined()
    expect(verifyFrame(secret, 'garbage')).toBeUndefined()
    expect(verifyFrame(secret, '')).toBeUndefined()
  })
})

describe('payload projection', () => {
  test('keeps only the fields the channel uses; never the prompt or tool_response', () => {
    const projected = projectHookPayload('PostToolUse', {
      hook_event_name: 'PostToolUse',
      session_id: 's',
      cwd: '/repo',
      transcript_path: '/x.jsonl',
      tool_name: 'Write',
      tool_input: {
        file_path: '/repo/a.ts',
        content: 'x'.repeat(10_000),
        old_string: 'secret before',
        new_string: 'secret after',
        description: 'd'.repeat(2000),
        nested: { a: 1 },
      },
      tool_response: { huge: 'y'.repeat(100_000) },
    })
    // Only the allowlisted fields (F9): never `content`, `old_string`, `new_string`.
    expect(projected).toEqual({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      cwd: '/repo',
      tool_name: 'Write',
      tool_input: { file_path: '/repo/a.ts', description: 'd'.repeat(1024) },
    })
    expect(
      projectHookPayload('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
    ).toEqual({ hook_event_name: 'UserPromptSubmit' })
  })

  test('the event name comes from the hook command; odd stdin still gives a frame', () => {
    expect(projectHookPayload('Stop', 'not an object')).toEqual({ hook_event_name: 'Stop' })
    expect(projectHookPayload('Notification', { hook_event_name: 'Stop', message: 'm' })).toEqual({
      hook_event_name: 'Notification',
      message: 'm',
    })
  })

  test('the worst case stays under the frame cap', () => {
    const control = '\u0001'.repeat(100_000) // JSON-escapes to six bytes per character
    const stop = projectHookPayload('Stop', { last_assistant_message: control, cwd: control })
    const tool = projectHookPayload('PostToolUse', {
      tool_name: control,
      tool_input: Object.fromEntries(
        ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'path', 'description'].map(
          (key) => [key, control],
        ),
      ),
    })
    for (const payload of [stop, tool]) {
      const frame = encodeFrame(new Uint8Array(32), JSON.stringify(payload))
      expect(Buffer.byteLength(frame)).toBeLessThan(MAX_FRAME_BYTES)
    }
  })
})

describe('secret file', () => {
  let dir: string
  beforeEach(() => {
    dir = makeTempDir()
  })
  afterEach(() => removeTempDir(dir))

  test('missing: read gives nothing and never creates it', () => {
    expect(readHookSecret(dir)).toBeUndefined()
    expect(readHookSecret(dir)).toBeUndefined()
  })

  test('created once, 32 bytes, then reused', () => {
    const first = loadOrCreateHookSecret(dir, new SequentialRandom())
    expect(first).toHaveLength(32)
    expect(readHookSecret(dir)).toEqual(Buffer.from(first))
    const again = loadOrCreateHookSecret(dir, { bytes: () => new Uint8Array(32).fill(9) })
    expect(Buffer.from(again)).toEqual(Buffer.from(first))
  })

  test.skipIf(process.platform === 'win32')('the file is 0600', () => {
    loadOrCreateHookSecret(dir, new SequentialRandom())
    expect(statSync(join(dir, HOOK_SECRET_FILE)).mode & 0o777).toBe(0o600)
  })

  test('a malformed file is not used', () => {
    writeFileSync(join(dir, HOOK_SECRET_FILE), 'not hex\n')
    expect(readHookSecret(dir)).toBeUndefined()
  })
})
