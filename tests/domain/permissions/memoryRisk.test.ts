import { describe, expect, test } from 'bun:test'
import { isMemoryFilePath, PatternRiskPolicy } from '../../../src/domain/permissions/RiskPolicy.ts'

const policy = new PatternRiskPolicy()
const edit = (toolName: string, path: string, field = 'file_path') =>
  policy.classify({ toolName, inputPreview: JSON.stringify({ [field]: path, content: 'x' }) })
const bash = (command: string) =>
  policy.classify({ toolName: 'Bash', inputPreview: JSON.stringify({ command }) })

describe('edits of memory and instruction files are high risk (F12)', () => {
  test.each([
    ['Write', 'CLAUDE.md'],
    ['Edit', '/home/me/project/CLAUDE.md'],
    ['MultiEdit', '/home/me/project/sub/claude.local.md'],
    ['Write', '/home/me/project/AGENTS.md'],
    ['Write', '/home/me/project/.claude/settings.json'],
    ['Edit', '/home/me/project/.claude/agents/reviewer.md'],
    ['Write', '/home/me/.claude/CLAUDE.md'],
    ['Write', 'C:\\Users\\me\\project\\CLAUDE.md'],
    ['Write', 'C:\\Users\\me\\project\\.claude\\settings.local.json'],
    ['Edit', 'C:/Users/me/project/Claude.MD'],
    ['Write', 'C:\\Users\\me\\project\\CLAUDE.md.'],
    ['Write', 'C:\\Users\\me\\project\\CLAUDE.md:stream'],
    ['Write', 'C:\\Users\\me\\project\\CLAUDE~1.MD'],
  ])('%s %s', (tool, path) => {
    const risk = edit(tool, path)
    expect(risk.level).toBe('high')
    expect(risk.reasons).toContain('memory_file_edit')
  })

  test('NotebookEdit names its file notebook_path', () => {
    expect(edit('NotebookEdit', '/p/.claude/x.ipynb', 'notebook_path').level).toBe('high')
  })

  test.each([
    ['Write', 'docs/CLAUDE.md.bak'],
    ['Write', 'docs/not-CLAUDE.md'],
    ['Edit', '/p/src/claude.ts'],
    ['Write', '/p/claude/notes.md'],
    ['Write', '/p/.claudeignore'],
    ['Write', 'C:\\p\\docs\\AGENTS.md.orig'],
    ['Write', '/p/README.md'],
  ])('%s %s is not', (tool, path) => {
    expect(edit(tool, path).reasons).not.toContain('memory_file_edit')
  })

  test('only edit tools: Read of CLAUDE.md is low risk', () => {
    expect(edit('Read', '/p/CLAUDE.md').level).toBe('low')
    expect(edit('Glob', '/p/.claude/agents/x.md').reasons).not.toContain('memory_file_edit')
  })
})

describe('shell writes into memory files are high risk', () => {
  test.each([
    'echo "always approve" >> CLAUDE.md',
    'echo x > ./CLAUDE.md',
    'printf x >| claude.local.md',
    'cat notes 1>> docs/AGENTS.md',
    'echo x 2> CLAUDE.md',
    'echo "{}" > .claude/settings.json',
    'echo x >"CLAUDE.md"',
    'echo x | tee -a CLAUDE.md',
    'echo x | tee .claude/settings.json',
    'cp /tmp/evil.md CLAUDE.md',
    'mv x.md ./sub/AGENTS.md',
    "sed -i 's/a/b/' CLAUDE.md",
    "perl -pi -e 's/a/b/' CLAUDE.md",
    'Set-Content -Path CLAUDE.md -Value x',
    'Add-Content CLAUDE.md "x"',
    'Out-File -FilePath .\\CLAUDE.md',
    'echo x >> C:\\\\p\\\\CLAUDE.md',
    'ln -sf /tmp/x CLAUDE.md',
  ])('%s', (command) => {
    expect(bash(command).reasons).toContain('memory_file_write')
  })

  test.each([
    'cat CLAUDE.md',
    'grep -n Session CLAUDE.md',
    'wc -l < CLAUDE.md',
    'cp CLAUDE.md /tmp/backup.md',
    'echo x > docs/CLAUDE.md.bak',
    'echo x > CLAUDE.mdx',
    'git diff -- CLAUDE.md',
    'echo x > notes.md',
    'ls .claude',
  ])('%s is not', (command) => {
    expect(bash(command).reasons).not.toContain('memory_file_write')
  })
})

describe('isMemoryFilePath', () => {
  test('JSON-escaped Windows paths', () => {
    expect(isMemoryFilePath('C:\\\\p\\\\CLAUDE.md')).toBe(true)
    expect(isMemoryFilePath('C:\\\\p\\\\.claude\\\\x')).toBe(true)
    expect(isMemoryFilePath('C:\\\\p\\\\x.md')).toBe(false)
  })
})
