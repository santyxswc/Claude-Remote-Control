/**
 * End-to-end check of the composition root: spawns `bun src/main.ts` the way
 * Claude Code does (MCP over stdio) and drives the F0 loop with a real MCP
 * client standing in for Claude Code.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repoRoot = join(import.meta.dir, '..')

let transport: StdioClientTransport
let client: Client
let stderr = ''
const transportErrors: Error[] = []
const notifications: unknown[] = []
let baseUrl: string

async function waitFor<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 20) {
    const value = probe()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${what}; stderr so far:\n${stderr}`)
}

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath, // the bun binary running the tests
    args: ['src/main.ts'],
    cwd: repoRoot,
    env: { TELEGRAM_BRIDGE_DEV_PORT: '0' },
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
}, 20_000)

afterAll(async () => {
  await client.close()
})

test('a POST reaches the session and the reply comes back on /events', async () => {
  expect(client.getServerVersion()?.name).toBe('telegram-bridge')

  const events = await fetch(`${baseUrl}/events`)
  const reader = events.body?.getReader()
  if (reader === undefined) throw new Error('no SSE body')
  await reader.read() // ": connected"

  const posted = await fetch(`${baseUrl}/`, { method: 'POST', body: 'what time is it?' })
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
  await reader.cancel()

  expect(transportErrors).toEqual([])
  expect(stderr).toContain('telegram-bridge [info] channel connected')
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
