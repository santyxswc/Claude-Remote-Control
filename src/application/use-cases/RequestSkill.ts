import type { SenderProfile } from '../../domain/Sender.ts'
import { skillKey } from '../../domain/skills/skillFrontmatter.ts'
import type { SkillTapOutcome } from '../i18n/messages.ts'
import type { InboundHandler } from '../pipeline/InboundStep.ts'
import type { BrakeFlag } from '../ports/BrakeFlag.ts'
import type { Clock } from '../ports/Clock.ts'
import type { ListSkills } from './ListSkills.ts'

/**
 * What a skill tap sends. Whether Claude Code runs a slash command that
 * arrives inside a channel event is not documented (needs live
 * verification), so the text is an instruction that works either way: as
 * prose Claude reads "use the skill /name" and invokes it with its Skill
 * tool; it is never a bare `/name` that could be taken for a bot command.
 */
export function skillInstruction(name: string): string {
  return `Use the skill /${name}`
}

export interface RequestSkillInput {
  readonly key: string
  readonly sender: SenderProfile
  readonly chatId: string
  readonly messageId: string | undefined
}

/**
 * A tap on a `/skills` button (F7): the instruction to use that skill is
 * fed to the inbound chain exactly like text the owner typed, so the rate
 * limit, the brake gate and the audit apply as usual. The skill is looked up
 * again on disk; a key that no longer matches sends nothing.
 */
export class RequestSkill {
  constructor(
    private readonly deps: {
      readonly list: ListSkills
      /** The inbound chain (after the tap path's own authentication). */
      readonly deliver: InboundHandler
      readonly brake: Pick<BrakeFlag, 'status'>
      readonly clock: Clock
    },
  ) {}

  async execute(input: RequestSkillInput): Promise<SkillTapOutcome> {
    const { skills } = await this.deps.list.execute()
    const skill = skills.find((candidate) => skillKey(candidate.name) === input.key)
    if (skill === undefined) return 'not_found'
    // Checked here for the toast; the chain's brake gate refuses it again anyway.
    if (this.deps.brake.status().engaged) return 'braked'
    await this.deps.deliver({
      chatId: input.chatId,
      messageId: input.messageId ?? '0',
      chatKind: 'private',
      sender: input.sender,
      text: skillInstruction(skill.name),
      sentAt: this.deps.clock.now(),
    })
    return 'sent'
  }
}
