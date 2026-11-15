/**
 * End-to-end check of the composition root: spawns `bun src/main.ts` the way
 * Claude Code does (MCP over stdio) and drives the F0 loop with a real MCP
 * client standing in for Claude Code.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { makeTempDir, removeTempDir } from './tempDir.ts'

const repoRoot = join(import.meta.dir, '..')

let transport: StdioClientTransport
let client: Client
let stderr = ''
const transportErrors: Error[] = []
const notifications: unknown[] = []
let baseUrl: string
let devToken: string
const authorized = () => ({ Authorization: `Bearer ${devToken}` })
let stateDir: string
let projectDir: string
const PROJECT_SECRET = 'Zq8!vR2#pL-0042-main'

async function waitFor<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 20) {
    const value = probe()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${what}; stderr so far:\n${stderr}`)
}

beforeAll(async () => {
  // Never the real ~/.claude state, and never a real token: the server must not reach Telegram.
  stateDir = makeTempDir()
  projectDir = makeTempDir()
  // The server reads the project's env files (CLAUDE_PROJECT_DIR) to redact their values.
  writeFileSync(join(projectDir, '.env'), `API_SECRET=${PROJECT_SECRET}\n`)
  transport = new StdioClientTransport({
    command: process.execPath, // the bun binary running the tests
    args: ['src/main.ts'],
    cwd: repoRoot,
    env: {
      TELEGRAM_BRIDGE_DEV_PORT: '0',
      TELEGRAM_BRIDGE_HOME: stateDir,
      TELEGRAM_BRIDGE_LOG_FILE: join(stateDir, 'channel.log'),
      TELEGRAM_BOT_TOKEN: '',
      CLAUDE_PROJECT_DIR: projectDir,
    },
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  client = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  // A non-JSON line on stdout surfaces here as a parse error.
  client.onerror = (error) => transportErrors.push(error)
  client.fallbackNotificationHandler = async (notification) => {
    notifications.push(notification)
  }
  await client.connect(transport)

  baseUrl = await waitFor(
    () => /dev inbound listening \{"url":"(http:\/\/127\.0\.0\.1:\d+)"\}/.exec(stderr)?.[1],
    'the dev listener',
  )
  // Claude Code redacts `Bearer <token>` in its debug log, so the token is read from the
  // owner-only header file the curl lines on stderr point to, as a developer would.
  const tokenFile = await waitFor(
    () => /curl -X POST -H "@([^"]+)"/.exec(stderr)?.[1],
    'the dev token file',
  )
  expect(tokenFile).toBe(join(stateDir, 'dev-token'))
  devToken =
    /^Authorization: Bearer ([A-Za-z0-9_-]{43})\n$/.exec(readFileSync(tokenFile, 'utf8'))?.[1] ?? ''
  expect(devToken).not.toBe('')
  expect(stderr).not.toContain(devToken)
}, 20_000)

afterAll(async () => {
  await client.close()
  removeTempDir(stateDir)
  removeTempDir(projectDir)
})

test('a POST reaches the session and the reply comes back on /events', async () => {
  expect(client.getServerVersion()?.name).toBe('telegram-bridge')

  // M4: the token is required, and only on loopback without an Origin.
  expect((await fetch(`${baseUrl}/`, { method: 'POST', body: 'no token' })).status).toBe(401)
  expect(notifications).toEqual([])

  const events = await fetch(`${baseUrl}/events`, { headers: authorized() })
  const reader = events.body?.getReader()
  if (reader === undefined) throw new Error('no SSE body')
  await reader.read() // ": connected"

  const posted = await fetch(`${baseUrl}/`, {
    method: 'POST',
    body: 'what time is it?',
    headers: authorized(),
  })
  expect(posted.status).toBe(200)

  const notification = await waitFor(() => notifications[0], 'the channel notification')
  expect(notification).toEqual({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: { content: 'what time is it?', meta: { chat_id: 'dev' } },
  })

  // Claude answers through the reply tool, as instructed.
  const result = await client.callTool({
    name: 'reply',
    arguments: { chat_id: 'dev', text: 'noon' },
  })
  expect(result.isError).toBeFalsy()

  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toBe(
    'event: reply\ndata: {"chat_id":"dev","text":"noon"}\n\n',
  )

  // Even the dev route goes through the outbound redaction wired in main.ts.
  const leaky = await client.callTool({
    name: 'reply',
    arguments: { chat_id: 'dev', text: `key ${PROJECT_SECRET}` },
  })
  expect(leaky.content).toEqual([
    { type: 'text', text: 'sent; 1 secret(s) were replaced with [REDACTED]' },
  ])
  const redacted = await reader.read()
  expect(new TextDecoder().decode(redacted.value)).toBe(
    'event: reply\ndata: {"chat_id":"dev","text":"key [REDACTED]"}\n\n',
  )

  // Without a token nobody is reachable on Telegram, and that is a tool error, not a crash.
  const nowhere = await client.callTool({
    name: 'reply',
    arguments: { chat_id: '5000000001', text: 'hi' },
  })
  expect(nowhere.isError).toBe(true)
  await reader.cancel()
  expect(stderr).not.toContain(PROJECT_SECRET)

  expect(transportErrors).toEqual([])
  expect(stderr).toContain('telegram-bridge [info] channel connected')
})

test('without a token it says how to configure, creates its state and keeps serving MCP', async () => {
  await waitFor(
    () => (stderr.includes('telegram is not configured') ? true : undefined),
    'the hint',
  )
  expect(stderr).toContain(
    'telegram-bridge [warn] telegram is not configured; run `bun run bridge -- init`',
  )
  expect(existsSync(join(stateDir, 'bridge.sqlite'))).toBe(true)
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['reply'])
})

test('the process exits when the client closes stdin', async () => {
  const pid = transport.pid
  if (pid === null) throw new Error('no child pid')

  await client.close()

  await waitFor(() => {
    try {
      process.kill(pid, 0)
      return undefined
    } catch {
      return true
    }
  }, 'the server process to exit')
})

test('L3: a relative TELEGRAM_BRIDGE_HOME keeps serving MCP without telegram and creates nothing in cwd', async () => {
  const cwd = makeTempDir()
  let err = ''
  const bad = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'src', 'main.ts')],
    cwd,
    env: { TELEGRAM_BRIDGE_HOME: 'relative-state', TELEGRAM_BOT_TOKEN: '' },
    stderr: 'pipe',
  })
  bad.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8')
  })
  const badClient = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  try {
    await badClient.connect(bad)
    expect((await badClient.listTools()).tools.map((t) => t.name)).toEqual(['reply'])
    for (let i = 0; i < 500 && !err.includes('state directory'); i++) await Bun.sleep(10)
    expect(err).toContain('TELEGRAM_BRIDGE_HOME')
    expect(existsSync(join(cwd, 'relative-state'))).toBe(false)
  } finally {
    await badClient.close()
    removeTempDir(cwd)
  }
}, 20_000)

test('a malformed TELEGRAM_BRIDGE_DEV_PORT is logged and the channel keeps serving MCP', async () => {
  const dir = makeTempDir()
  let err = ''
  const typo = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'src', 'main.ts')],
    cwd: repoRoot,
    env: { TELEGRAM_BRIDGE_DEV_PORT: '87 88', TELEGRAM_BRIDGE_HOME: dir, TELEGRAM_BOT_TOKEN: '' },
    stderr: 'pipe',
  })
  typo.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8')
  })
  const typoClient = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  try {
    await typoClient.connect(typo)
    expect((await typoClient.listTools()).tools.map((t) => t.name)).toEqual(['reply'])
    for (let i = 0; i < 500 && !err.includes('invalid dev port'); i++) await Bun.sleep(10)
    expect(err).toContain('invalid dev port; the dev listener is off')
    expect(err).not.toContain('dev inbound listening')
  } finally {
    await typoClient.close()
    removeTempDir(dir)
  }
}, 20_000)

// Claude Code 2.1.325 keeps a server's stderr only until the connection is up.
test('TELEGRAM_BRIDGE_LOG_FILE gets the same lines as stderr, without the dev token', () => {
  const logged = readFileSync(join(stateDir, 'channel.log'), 'utf8')
  expect(logged).toContain('telegram-bridge [info] channel connected')
  expect(logged).toContain('telegram-bridge [info] dev inbound listening')
  expect(logged).not.toContain(devToken)
  expect(logged).not.toContain(PROJECT_SECRET)
  for (const line of logged.trimEnd().split('\n')) {
    expect(stderr).toContain(line)
  }
})
