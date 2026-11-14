import { describe, expect, test } from 'bun:test'
import { messagesFor } from '../../../src/application/i18n/messages.ts'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import type { SkillFile, SkillFiles } from '../../../src/application/ports/SkillFiles.ts'
import {
  renderSkillsMenu,
  SKILLS_PER_PAGE,
  SkillsMenu,
} from '../../../src/application/skills/SkillsMenu.ts'
import {
  encodeSkillCallback,
  parseSkillCallback,
} from '../../../src/application/skills/skillCallbackData.ts'
import { ListSkills } from '../../../src/application/use-cases/ListSkills.ts'
import { RequestSkill, skillInstruction } from '../../../src/application/use-cases/RequestSkill.ts'
import { skillKey } from '../../../src/domain/skills/skillFrontmatter.ts'
import {
  ALICE,
  FakeClock,
  FakePromptGateway,
  InMemoryBrakeFlag,
  MemoryLogger,
} from '../../fakes.ts'

const en = messagesFor('en')

class StaticSkillFiles implements SkillFiles {
  constructor(
    public files: SkillFile[],
    public projectKnown = true,
  ) {}
  async scan() {
    return { projectKnown: this.projectKnown, files: this.files }
  }
}

const file = (dirName: string, content: string, scope: SkillFile['scope'] = 'project') => ({
  dirName,
  content,
  scope,
})

describe('skill callback data', () => {
  test('round trip', () => {
    expect(parseSkillCallback(encodeSkillCallback({ kind: 'skill', key: '0123abcd' }))).toEqual({
      kind: 'skill',
      key: '0123abcd',
    })
    expect(parseSkillCallback(encodeSkillCallback({ kind: 'page', page: 12 }))).toEqual({
      kind: 'page',
      page: 12,
    })
  })

  test.each([
    undefined,
    '',
    'k1:',
    'k1:0123ABCD',
    'k1:0123abc',
    'k1:p',
    'k1:p1000',
    'k1:deploy',
    'k2:p1',
    'c1:abcdefghij:0',
  ])('rejects %p', (data) => expect(parseSkillCallback(data)).toBeUndefined())

  test('encoding refuses bad input', () => {
    expect(() => encodeSkillCallback({ kind: 'skill', key: 'deploy' })).toThrow()
    expect(() => encodeSkillCallback({ kind: 'page', page: -1 })).toThrow()
  })
})

describe('ListSkills', () => {
  test('personal first on a clash, invalid and hidden ones skipped, sorted', async () => {
    const list = new ListSkills(
      new StaticSkillFiles([
        file('zeta', '---\ndescription: project zeta\n---\n'),
        file('alpha', '---\ndescription: project alpha\n---\n'),
        file('alpha', '---\ndescription: personal alpha\n---\n', 'user'),
        file('Bad Name', ''),
        file('hidden', '---\nuser-invocable: false\n---\n'),
      ]),
      new MemoryLogger(),
    )
    expect(await list.execute()).toEqual({
      projectKnown: true,
      skills: [
        { name: 'alpha', description: 'personal alpha' },
        { name: 'zeta', description: 'project zeta' },
      ],
    })
  })
})

describe('the menu', () => {
  const skills = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, description: `d${i}` }))

  test('one button per skill, pages above 8', () => {
    const first = renderSkillsMenu(skills, 0, true, en)
    expect(first.keyboard).toHaveLength(SKILLS_PER_PAGE + 1)
    expect(first.keyboard[0]).toEqual([{ label: 's0', data: `k1:${skillKey('s0')}` }])
    expect(first.keyboard.at(-1)).toEqual([{ label: en.skillsPageButtons.next, data: 'k1:p1' }])
    expect(first.text).toContain('• s0 - d0')
    const last = renderSkillsMenu(skills, 99, false, en)
    expect(last.keyboard.flat().map((b) => b.label)).toEqual([
      's8',
      's9',
      en.skillsPageButtons.previous,
    ])
    expect(last.text).toContain('page 2 of 2')
    expect(last.text).toContain('not known')
  })

  test('every callback data fits 64 bytes', () => {
    const long = [{ name: `a${'b'.repeat(63)}`, description: '' }]
    for (const row of renderSkillsMenu(long, 0, true, en).keyboard) {
      for (const button of row)
        expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64)
    }
  })

  test('nothing to list: says why', async () => {
    const prompts = new FakePromptGateway()
    const replies: string[] = []
    const menu = new SkillsMenu(
      new ListSkills(new StaticSkillFiles([], false), new MemoryLogger()),
      prompts,
      en,
    )
    await menu.send(ALICE.id, async (text) => void replies.push(text))
    expect(replies).toEqual([en.skillsNone(false)])
    expect(prompts.sent).toEqual([])
  })
})

describe('RequestSkill', () => {
  function harness(files: SkillFile[]) {
    const delivered: InboundMessage[] = []
    const brake = new InMemoryBrakeFlag()
    const request = new RequestSkill({
      list: new ListSkills(new StaticSkillFiles(files), new MemoryLogger()),
      deliver: async (message) => void delivered.push(message),
      brake,
      clock: new FakeClock(),
    })
    return { delivered, brake, request }
  }
  const input = (name: string) => ({
    key: skillKey(name),
    sender: ALICE,
    chatId: ALICE.id,
    messageId: '5',
  })

  test('feeds the instruction to the chain as text from the owner', async () => {
    const h = harness([file('deploy', '')])
    expect(await h.request.execute(input('deploy'))).toBe('sent')
    expect(h.delivered).toEqual([
      {
        chatId: ALICE.id,
        messageId: '5',
        chatKind: 'private',
        sender: ALICE,
        text: 'Use the skill /deploy',
        sentAt: new FakeClock().now(),
      },
    ])
    expect(skillInstruction('x')).toBe('Use the skill /x')
  })

  test('a skill no longer on disk sends nothing', async () => {
    const h = harness([file('deploy', '')])
    expect(await h.request.execute(input('gone'))).toBe('not_found')
    expect(h.delivered).toEqual([])
  })

  test('braked: nothing is sent', async () => {
    const h = harness([file('deploy', '')])
    h.brake.engage({ engagedAt: 0, actor: 'terminal', reason: undefined })
    expect(await h.request.execute(input('deploy'))).toBe('braked')
    expect(h.delivered).toEqual([])
  })
})
