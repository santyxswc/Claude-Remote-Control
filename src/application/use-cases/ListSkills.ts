import { type Skill, skillFromFile } from '../../domain/skills/skillFrontmatter.ts'
import type { Logger } from '../ports/Logger.ts'
import type { SkillFiles } from '../ports/SkillFiles.ts'

export interface SkillList {
  readonly projectKnown: boolean
  /** Sorted by name, one per name. */
  readonly skills: readonly Skill[]
}

/**
 * The skills `/skills` offers (F7): user and project `SKILL.md` files whose
 * name passes `SKILL_NAME`. A name in both places is listed once (personal
 * first, as Claude Code resolves it). Read fresh every time, so a tap always
 * acts on what is on disk now.
 */
export class ListSkills {
  constructor(
    private readonly files: SkillFiles,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<SkillList> {
    const scan = await this.files.scan()
    const ordered = [...scan.files].sort((a, b) =>
      a.scope === b.scope ? 0 : a.scope === 'user' ? -1 : 1,
    )
    const byName = new Map<string, Skill>()
    let skipped = 0
    for (const file of ordered) {
      const skill = skillFromFile(file.dirName, file.content)
      if (skill === undefined) skipped += 1
      else if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
    if (skipped > 0) this.logger.info('skills not listed (name or user-invocable)', { skipped })
    const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    return { projectKnown: scan.projectKnown, skills }
  }
}
