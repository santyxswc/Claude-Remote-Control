/** The last-tool line of the pinned status (F9): never command text or file content. */
import { describe, expect, test } from 'bun:test'
import { MAX_TOOL_DETAIL_SHOWN, summarizeToolUse } from '../../../src/domain/status/toolActivity.ts'

describe('summarizeToolUse', () => {
  test('shell tools show their description, never the command', () => {
    const activity = summarizeToolUse('Bash', {
      command: 'curl -H "Authorization: Bearer abc" https://x',
      description: 'Run the unit tests',
    })
    expect(activity).toEqual({ tool: 'Bash', detail: 'Run the unit tests' })
    expect(summarizeToolUse('PowerShell', { command: 'rm -r x' })).toEqual({ tool: 'PowerShell' })
    expect(summarizeToolUse('Bash', { command: 'x', description: '   ' })).toEqual({ tool: 'Bash' })
  })

  test('file tools show the base name only', () => {
    expect(summarizeToolUse('Edit', { file_path: '/home/me/secret-project/src/app.ts' })).toEqual({
      tool: 'Edit',
      detail: 'app.ts',
    })
    expect(summarizeToolUse('Read', { file_path: 'C:\\Users\\me\\notes.md' })).toEqual({
      tool: 'Read',
      detail: 'notes.md',
    })
    expect(summarizeToolUse('NotebookEdit', { notebook_path: '/a/b/nb.ipynb' })).toEqual({
      tool: 'NotebookEdit',
      detail: 'nb.ipynb',
    })
    expect(summarizeToolUse('Write', { file_path: '/a/b/' })).toEqual({
      tool: 'Write',
      detail: 'b',
    })
  })

  test('other tools show their name only: no patterns, URLs or queries', () => {
    expect(summarizeToolUse('Grep', { pattern: 'password=.*', path: '/x' })).toEqual({
      tool: 'Grep',
    })
    expect(summarizeToolUse('WebFetch', { url: 'https://x/?token=abc' })).toEqual({
      tool: 'WebFetch',
    })
    expect(summarizeToolUse('mcp__x__y', undefined)).toEqual({ tool: 'mcp__x__y' })
    // A description on a tool that is not a shell is not trusted to be a summary.
    expect(summarizeToolUse('Task', { description: 'anything' })).toEqual({ tool: 'Task' })
  })

  test('non-string fields are ignored', () => {
    expect(summarizeToolUse('Bash', { description: 42 })).toEqual({ tool: 'Bash' })
    expect(summarizeToolUse('Edit', { file_path: ['a'] })).toEqual({ tool: 'Edit' })
  })

  test('sanitized and capped', () => {
    const activity = summarizeToolUse('Bash', {
      description: `Do\u202e things\n${'x'.repeat(200)}`,
    })
    expect(activity.detail).toBeDefined()
    expect(activity.detail).not.toMatch(/[\n\u202e]/)
    expect([...(activity.detail ?? '')].length).toBeLessThanOrEqual(MAX_TOOL_DETAIL_SHOWN)
    expect(
      summarizeToolUse(`Ba\u0007sh${'y'.repeat(200)}`, undefined).tool.length,
    ).toBeLessThanOrEqual(64)
  })
})
