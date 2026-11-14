import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  ClaudeMdMemoryFile,
  MAX_MEMORY_FILE_BYTES,
} from '../../../src/adapters/project/ClaudeMdMemoryFile.ts'
import { FileSessionSummaryStore } from '../../../src/adapters/project/FileSessionSummaryStore.ts'
import { ProjectFileError } from '../../../src/application/errors.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

let root: string
let project: string
let outside: string

beforeEach(() => {
  root = makeTempDir()
  project = join(root, 'project')
  outside = join(root, 'outside')
  mkdirSync(project)
  mkdirSync(outside)
})

afterEach(() => {
  removeTempDir(root)
})

/** A directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
function linkDir(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

/** File symlinks need a privilege (or developer mode) on Windows: skip when refused. */
function linkFile(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch {
    return false
  }
}

async function problemOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof ProjectFileError) return error.problem
    throw error
  }
  return 'none'
}

describe('FileSessionSummaryStore', () => {
  const name = (attempt: number) => (attempt === 0 ? 'x.md' : `x-${attempt + 1}.md`)

  test('creates docs/sessions and the file, then never overwrites', async () => {
    const store = new FileSessionSummaryStore(project)
    expect(await store.save(name, 'one\n')).toEqual({ relativePath: 'docs/sessions/x.md' })
    expect(await store.save(name, 'two\n')).toEqual({ relativePath: 'docs/sessions/x-2.md' })
    const dir = join(project, 'docs', 'sessions')
    expect(readFileSync(join(dir, 'x.md'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(dir, 'x-2.md'), 'utf8')).toBe('two\n')
  })

  test('UTF-8 content is written as is', async () => {
    const store = new FileSessionSummaryStore(project)
    await store.save(name, '# Revisión ✓\n')
    expect(readFileSync(join(project, 'docs', 'sessions', 'x.md'), 'utf8')).toBe('# Revisión ✓\n')
  })

  test('gives up after many collisions', async () => {
    const store = new FileSessionSummaryStore(project)
    expect(await problemOf(store.save(() => 'same.md', 'a'))).toBe('none')
    expect(await problemOf(store.save(() => 'same.md', 'b'))).toBe('no_free_name')
  })

  test('a docs link leading outside the project is refused and nothing is written there', async () => {
    if (!linkDir(outside, join(project, 'docs'))) return
    const store = new FileSessionSummaryStore(project)
    expect(await problemOf(store.save(name, 'x'))).toBe('outside_project')
    expect(readdirSync(outside)).toEqual([])
  })

  test('a sessions link leading outside is refused too', async () => {
    mkdirSync(join(project, 'docs'))
    if (!linkDir(outside, join(project, 'docs', 'sessions'))) return
    const store = new FileSessionSummaryStore(project)
    expect(await problemOf(store.save(name, 'x'))).toBe('outside_project')
    expect(readdirSync(outside)).toEqual([])
  })

  test('a link that stays inside the project is fine', async () => {
    mkdirSync(join(project, 'notes'))
    if (!linkDir(join(project, 'notes'), join(project, 'docs'))) return
    const store = new FileSessionSummaryStore(project)
    expect(await problemOf(store.save(name, 'x'))).toBe('none')
    expect(existsSync(join(project, 'notes', 'sessions', 'x.md'))).toBe(true)
  })

  test('a file named docs is refused', async () => {
    writeFileSync(join(project, 'docs'), 'x')
    const store = new FileSessionSummaryStore(project)
    expect(await problemOf(store.save(name, 'x'))).toBe('not_a_regular_file')
  })

  test('an existing file link at the name is never followed', async () => {
    mkdirSync(join(project, 'docs', 'sessions'), { recursive: true })
    const victim = join(outside, 'victim.md')
    writeFileSync(victim, 'keep')
    if (!linkFile(victim, join(project, 'docs', 'sessions', 'x.md'))) return
    const store = new FileSessionSummaryStore(project)
    expect(await store.save(name, 'new')).toEqual({ relativePath: 'docs/sessions/x-2.md' })
    expect(readFileSync(victim, 'utf8')).toBe('keep')
  })
})

describe('ClaudeMdMemoryFile', () => {
  const claudeMd = () => join(project, 'CLAUDE.md')

  test('creates CLAUDE.md with the section when there is none', async () => {
    const file = new ClaudeMdMemoryFile(project)
    expect(await file.append(['a'])).toEqual({ relativePath: 'CLAUDE.md', created: true })
    expect(readFileSync(claudeMd(), 'utf8')).toBe('## Session notes\n\n- a\n')
  })

  test('keeps everything else byte for byte, CRLF included, and leaves no temp file', async () => {
    writeFileSync(claudeMd(), '# P\r\n\r\nRules.\r\n')
    const file = new ClaudeMdMemoryFile(project)
    expect(await file.append(['a', 'b'])).toEqual({ relativePath: 'CLAUDE.md', created: false })
    expect(readFileSync(claudeMd(), 'utf8')).toBe(
      '# P\r\n\r\nRules.\r\n\r\n## Session notes\r\n\r\n- a\r\n- b\r\n',
    )
    await file.append(['c'])
    expect(readFileSync(claudeMd(), 'utf8').match(/## Session notes/g)).toHaveLength(1)
    expect(readdirSync(project)).toEqual(['CLAUDE.md'])
  })

  test('keeps the file mode', async () => {
    if (process.platform === 'win32') return
    writeFileSync(claudeMd(), '# P\n', { mode: 0o640 })
    await new ClaudeMdMemoryFile(project).append(['a'])
    expect(statSync(claudeMd()).mode & 0o777).toBe(0o640)
  })

  test('an oversized file is refused and untouched', async () => {
    const big = 'x'.repeat(MAX_MEMORY_FILE_BYTES + 1)
    writeFileSync(claudeMd(), big)
    expect(await problemOf(new ClaudeMdMemoryFile(project).append(['a']))).toBe('too_large')
    expect(readFileSync(claudeMd(), 'utf8')).toBe(big)
  })

  test('a directory named CLAUDE.md is refused', async () => {
    mkdirSync(claudeMd())
    expect(await problemOf(new ClaudeMdMemoryFile(project).append(['a']))).toBe(
      'not_a_regular_file',
    )
  })

  test('a CLAUDE.md link leading outside the project is refused and the target untouched', async () => {
    const victim = join(outside, 'victim.md')
    writeFileSync(victim, 'keep')
    if (!linkFile(victim, claudeMd())) return
    expect(await problemOf(new ClaudeMdMemoryFile(project).append(['a']))).toBe('outside_project')
    expect(readFileSync(victim, 'utf8')).toBe('keep')
  })

  test('a CLAUDE.md link inside the project is followed, and stays a link', async () => {
    const real = join(project, 'docs-claude.md')
    writeFileSync(real, '# P\n')
    if (!linkFile(real, claudeMd())) return
    await new ClaudeMdMemoryFile(project).append(['a'])
    expect(readFileSync(real, 'utf8')).toContain('- a')
    expect(lstatSync(claudeMd()).isSymbolicLink()).toBe(true)
  })

  test('a project reached through a link resolves to its real directory', async () => {
    const alias = join(root, 'alias')
    if (!linkDir(project, alias)) return
    await new ClaudeMdMemoryFile(alias).append(['a'])
    expect(readFileSync(claudeMd(), 'utf8')).toContain('- a')
  })
})
