import { describe, expect, test } from 'bun:test'
import {
  MAX_FRONTMATTER_LINES,
  parseSkillFrontmatter,
  SKILL_NAME,
  skillFromFile,
  skillKey,
} from '../../../src/domain/skills/skillFrontmatter.ts'

describe('parseSkillFrontmatter', () => {
  test('plain, quoted and commented scalars', () => {
    expect(
      parseSkillFrontmatter(
        '---\nname: deploy\ndescription: "Ship it: now" # why\nother: x\n---\nbody\n',
      ),
    ).toEqual({ name: 'deploy', description: 'Ship it: now' })
    expect(parseSkillFrontmatter("---\ndescription: 'It''s fine'\n---\n")).toEqual({
      description: "It's fine",
    })
  })

  test('block scalars are read as one line (the menu shows one line anyway)', () => {
    expect(
      parseSkillFrontmatter('---\ndescription: |\n  line one\n  line two\nname: x\n---\n'),
    ).toEqual({ name: 'x', description: 'line one line two' })
    expect(parseSkillFrontmatter('---\ndescription: >\n  folded\n  text\n---\n')).toMatchObject({
      description: 'folded text',
    })
  })

  test('user-invocable: false is noticed', () => {
    expect(parseSkillFrontmatter('---\nuser-invocable: false\n---\n')).toEqual({
      userInvocable: false,
    })
  })

  test('CRLF and a BOM are fine', () => {
    expect(parseSkillFrontmatter('\u{feff}---\r\nname: a\r\n---\r\n')).toEqual({ name: 'a' })
  })

  test.each([
    ['no frontmatter', 'name: a\n'],
    ['not on the first line', '\n---\nname: a\n---\n'],
    ['never closed', '---\nname: a\n'],
    ['too long', `---\n${'x: y\n'.repeat(MAX_FRONTMATTER_LINES + 1)}name: a\n---\n`],
    ['empty', ''],
  ])('%s gives nothing', (_what, text) => {
    expect(parseSkillFrontmatter(text)).toEqual({})
  })

  test('nested keys are not top-level fields', () => {
    expect(parseSkillFrontmatter('---\nmeta:\n  name: inner\n---\n')).toEqual({})
  })
})

describe('skillFromFile', () => {
  test('the name defaults to the directory', () => {
    expect(skillFromFile('deploy', '---\ndescription: Ship\n---\n')).toEqual({
      name: 'deploy',
      description: 'Ship',
    })
    expect(skillFromFile('dir', 'no frontmatter')).toEqual({ name: 'dir', description: '' })
  })

  test('hidden and badly named skills are skipped', () => {
    expect(skillFromFile('x', '---\nuser-invocable: false\n---\n')).toBeUndefined()
    for (const name of ['Bad', '-x', 'a b', '../x', 'a/b', 'x'.repeat(65), '', 'ñ']) {
      expect(skillFromFile(name, '')).toBeUndefined()
    }
    expect(skillFromFile('ok', '---\nname: "rm -rf /"\n---\n')).toBeUndefined()
  })

  test('descriptions are sanitized and capped', () => {
    const skill = skillFromFile('x', `---\ndescription: "a\u{202e}b ${'z'.repeat(3000)}"\n---\n`)
    expect(skill?.description).not.toContain('\u{202e}')
    expect([...(skill?.description ?? '')].length).toBeLessThanOrEqual(1536)
  })
})

test('SKILL_NAME and skillKey', () => {
  expect(SKILL_NAME.test('plugin:skill_1-x')).toBe(true)
  expect(skillKey('deploy')).toMatch(/^[0-9a-f]{8}$/)
  expect(skillKey('deploy')).toBe(skillKey('deploy'))
  expect(skillKey('deploy')).not.toBe(skillKey('deplo'))
})
