import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import { type Skill, skillKey } from '../../domain/skills/skillFrontmatter.ts'
import type { Messages } from '../i18n/messages.ts'
import type { PromptGateway, PromptKeyboard } from '../ports/PromptGateway.ts'
import type { ListSkills } from '../use-cases/ListSkills.ts'
import { encodeSkillCallback } from './skillCallbackData.ts'

/** Skills per page of `/skills`; more get Previous / Next buttons. */
export const SKILLS_PER_PAGE = 8

export interface RenderedSkillsMenu {
  readonly text: string
  readonly keyboard: PromptKeyboard
}

/** One page: the names and descriptions as text, one button per skill, then the page buttons. */
export function renderSkillsMenu(
  skills: readonly Skill[],
  requestedPage: number,
  projectKnown: boolean,
  messages: Messages,
): RenderedSkillsMenu {
  const pages = Math.max(1, Math.ceil(skills.length / SKILLS_PER_PAGE))
  const page = Math.min(Math.max(0, requestedPage), pages - 1)
  const shown = skills.slice(page * SKILLS_PER_PAGE, (page + 1) * SKILLS_PER_PAGE)
  const rows: PromptKeyboard = shown.map((skill) => [
    { label: skill.name, data: encodeSkillCallback({ kind: 'skill', key: skillKey(skill.name) }) },
  ])
  const nav = [
    ...(page > 0
      ? [
          {
            label: messages.skillsPageButtons.previous,
            data: encodeSkillCallback({ kind: 'page', page: page - 1 }),
          },
        ]
      : []),
    ...(page < pages - 1
      ? [
          {
            label: messages.skillsPageButtons.next,
            data: encodeSkillCallback({ kind: 'page', page: page + 1 }),
          },
        ]
      : []),
  ]
  return {
    text: messages.skillsMenu({ skills: shown, page, pages, projectKnown }),
    keyboard: nav.length === 0 ? rows : [...rows, nav],
  }
}

/** `/skills` as a message with buttons, and its pages. Everything goes through the redacting gateway. */
export class SkillsMenu {
  constructor(
    private readonly list: ListSkills,
    private readonly prompts: PromptGateway,
    private readonly messages: Messages,
  ) {}

  /** Sends the first page, or says there is nothing to list (and why). */
  async send(chatId: string, reply: (text: string) => Promise<void>): Promise<void> {
    const { skills, projectKnown } = await this.list.execute()
    if (skills.length === 0) {
      await reply(this.messages.skillsNone(projectKnown))
      return
    }
    const menu = renderSkillsMenu(skills, 0, projectKnown, this.messages)
    await this.prompts.sendPrompt(chatId, menu.text, menu.keyboard)
  }

  /** Replaces the menu in `ref` with another page (clamped to the pages that exist now). */
  async showPage(ref: PromptRef, page: number): Promise<void> {
    const { skills, projectKnown } = await this.list.execute()
    const menu = renderSkillsMenu(skills, page, projectKnown, this.messages)
    await this.prompts.editPrompt(
      ref,
      skills.length === 0 ? this.messages.skillsNone(projectKnown) : menu.text,
      skills.length === 0 ? [] : menu.keyboard,
    )
  }
}
