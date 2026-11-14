/**
 * The plugin packaging (ADR 0009): `.claude-plugin/plugin.json`,
 * `hooks/hooks.json` and the dev `.mcp.json` stay consistent with the code.
 * `claude plugin validate .` remains the authoritative check.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import packageJson from '../../package.json' with { type: 'json' }
import { HOOK_EVENT_NAMES } from '../../src/application/hooks/hookEventNames.ts'

const root = join(import.meta.dir, '..', '..')
// Claude Code substitutes this placeholder; here it is literal text.
const PLUGIN_ROOT = ['${', 'CLAUDE_PLUGIN_ROOT', '}'].join('')

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8'))

interface CommandHook {
  type: string
  command: string
  args?: string[]
  timeout?: number
  async?: boolean
}

interface McpServer {
  command: string
  args: string[]
  env?: Record<string, string>
}

const plugin = readJson('.claude-plugin/plugin.json') as {
  name: string
  version: string
  mcpServers: Record<string, McpServer>
}
const hooksFile = readJson('hooks/hooks.json') as {
  hooks: Record<string, { matcher?: string; hooks: CommandHook[] }[]>
}
const devMcp = readJson('.mcp.json') as { mcpServers: Record<string, McpServer> }

/** `${CLAUDE_PLUGIN_ROOT}/x/y.ts` -> `x/y.ts` relative to the repository. */
function inPlugin(arg: string): string {
  expect(arg.startsWith(`${PLUGIN_ROOT}/`)).toBe(true)
  return arg.slice(PLUGIN_ROOT.length + 1)
}

describe('plugin.json', () => {
  test('name and a version kept in sync with package.json', () => {
    expect(plugin.name).toBe('telegram-bridge')
    expect(plugin.version).toBe(packageJson.version)
  })

  test('the server replaces the dev entry of the same name and runs from the plugin root', () => {
    const server = plugin.mcpServers['telegram-bridge']
    expect(server).toBeDefined()
    expect(devMcp.mcpServers['telegram-bridge']).toBeDefined()
    expect(server?.command).toBe('bun')
    const args = server?.args ?? []
    expect(args.slice(0, 3)).toEqual(['run', '--cwd', PLUGIN_ROOT])
    // Windows-safe redirection of `bun install` output away from the MCP stdout.
    expect(args).toContain('--shell=bun')
    expect(args).toContain('--silent')
    const script = args.at(-1) ?? ''
    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts[script]).toMatch(/^bun install .*--production .*1>&2 && bun src\/main\.ts$/)
    expect(existsSync(join(root, 'src', 'main.ts'))).toBe(true)
    // Same environment forwarding as the dev entry.
    expect(server?.env).toEqual(devMcp.mcpServers['telegram-bridge']?.env)
  })
})

describe('hooks/hooks.json', () => {
  const events = Object.keys(hooksFile.hooks)

  test('registers exactly the events the hook entrypoint handles', () => {
    expect([...events].sort()).toEqual([...HOOK_EVENT_NAMES].sort())
  })

  test('every hook is exec form: bun, an existing script under the plugin root, its event', () => {
    for (const event of events) {
      for (const group of hooksFile.hooks[event] ?? []) {
        expect(group.matcher).toBeUndefined() // every tool, every notification type
        for (const hook of group.hooks) {
          expect(hook.type).toBe('command')
          expect(hook.command).toBe('bun')
          const [script, eventArg, ...rest] = hook.args ?? []
          expect(existsSync(join(root, inPlugin(script ?? '')))).toBe(true)
          expect(eventArg).toBe(event)
          expect(rest).toEqual([])
          expect(hook.async).toBe(true)
          expect(hook.timeout).toBeLessThanOrEqual(10)
        }
      }
    }
  })

  test('the hook script needs no installed dependency', () => {
    // Hooks run before `bun install` ever did (it only runs with the server).
    const visited = new Set<string>()
    const visit = (file: string): void => {
      if (visited.has(file)) return
      visited.add(file)
      const source = readFileSync(file, 'utf8')
      for (const [, spec] of source.matchAll(/^import[^'"]*from\s+'([^']+)'/gm)) {
        if (spec === undefined) continue
        if (spec.startsWith('.')) {
          visit(join(file, '..', spec))
        } else {
          expect(spec.startsWith('node:')).toBe(true)
        }
      }
    }
    visit(join(root, 'src', 'hook.ts'))
    expect(visited.size).toBeGreaterThan(1)
  })
})
