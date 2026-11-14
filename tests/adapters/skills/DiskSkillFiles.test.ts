import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DiskSkillFiles,
  MAX_SKILL_FILE_BYTES,
  resolveProjectDir,
} from '../../../src/adapters/skills/DiskSkillFiles.ts'
import { resolveClaudeConfigDir } from '../../../src/adapters/storage/stateDir.ts'
import { MemoryLogger } from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

let root: string
let project: string
let user: string

beforeEach(() => {
  root = makeTempDir()
  project = join(root, 'project')
  user = join(root, 'config', 'skills')
  mkdirSync(join(project, '.claude', 'skills'), { recursive: true })
  mkdirSync(user, { recursive: true })
})

afterEach(() => removeTempDir(root))

function skill(base: string, name: string, content = `---\ndescription: ${name}\n---\n`): string {
  mkdirSync(join(base, name), { recursive: true })
  const path = join(base, name, 'SKILL.md')
  writeFileSync(path, content)
  return path
}

/** Symlinks need privileges on Windows; skip those checks where they cannot be made. */
function trySymlink(target: string, path: string, type?: 'dir' | 'file'): boolean {
  try {
    symlinkSync(target, path, type)
    return true
  } catch {
    return false
  }
}

const projectSkills = () => join(project, '.claude', 'skills')

describe('DiskSkillFiles', () => {
  test('reads user and project SKILL.md files', async () => {
    skill(projectSkills(), 'deploy')
    skill(user, 'notes')
    const files = new DiskSkillFiles({
      projectDir: project,
      userSkillsDir: user,
      logger: new MemoryLogger(),
    })
    const scan = await files.scan()
    expect(scan.projectKnown).toBe(true)
    expect(scan.files.map((f) => [f.scope, f.dirName])).toEqual([
      ['user', 'notes'],
      ['project', 'deploy'],
    ])
    expect(scan.files[0]?.content).toContain('description: notes')
  })

  test('unknown project, missing dirs: no project files, no error', async () => {
    skill(user, 'notes')
    const scan = await new DiskSkillFiles({
      projectDir: undefined,
      userSkillsDir: join(root, 'missing'),
      logger: new MemoryLogger(),
    }).scan()
    expect(scan).toEqual({ projectKnown: false, files: [] })
  })

  test('oversized, directory-shaped and dot entries are skipped', async () => {
    skill(projectSkills(), 'big', 'x'.repeat(MAX_SKILL_FILE_BYTES + 1))
    mkdirSync(join(projectSkills(), 'dir', 'SKILL.md'), { recursive: true })
    skill(projectSkills(), '.hidden')
    writeFileSync(join(projectSkills(), 'loose.md'), 'x')
    skill(projectSkills(), 'ok')
    const scan = await new DiskSkillFiles({
      projectDir: project,
      userSkillsDir: undefined,
      logger: new MemoryLogger(),
    }).scan()
    expect(scan.files.map((f) => f.dirName)).toEqual(['ok'])
  })

  test('a symlink that leaves the skills directory is not followed', async () => {
    const outside = skill(join(root, 'elsewhere'), 'secret', '---\ndescription: outside\n---\n')
    mkdirSync(join(projectSkills(), 'linked'))
    const made =
      trySymlink(outside, join(projectSkills(), 'linked', 'SKILL.md'), 'file') &&
      trySymlink(join(root, 'elsewhere', 'secret'), join(projectSkills(), 'dirlink'), 'dir')
    if (!made) return
    const logger = new MemoryLogger()
    const scan = await new DiskSkillFiles({
      projectDir: project,
      userSkillsDir: undefined,
      logger,
    }).scan()
    expect(scan.files).toEqual([])
    expect(logger.text).toContain('outside its skills directory')
  })
})

describe('resolveProjectDir', () => {
  const none = () => false
  test('CLAUDE_PROJECT_DIR when absolute', () => {
    expect(resolveProjectDir({ CLAUDE_PROJECT_DIR: project }, '/cwd', none)).toBe(project)
    expect(resolveProjectDir({ CLAUDE_PROJECT_DIR: 'relative' }, '/cwd', none)).toBeUndefined()
    expect(resolveProjectDir({ CLAUDE_PROJECT_DIR: '  ' }, '/cwd', none)).toBeUndefined()
  })

  test('else the working directory if it looks like a project', () => {
    expect(resolveProjectDir({}, project, (p) => p === join(project, '.claude'))).toBe(project)
    expect(resolveProjectDir({}, project, (p) => p === join(project, '.git'))).toBe(project)
    expect(resolveProjectDir({}, project, none)).toBeUndefined()
  })
})

describe('resolveClaudeConfigDir', () => {
  test('CLAUDE_CONFIG_DIR, else ~/.claude; relative is refused', () => {
    const home = join(root, 'home')
    expect(resolveClaudeConfigDir({}, home)).toBe(join(home, '.claude'))
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: user }, home)).toBe(user)
    expect(() => resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: 'rel' }, home)).toThrow()
  })
})
