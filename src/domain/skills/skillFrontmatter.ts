import { sanitizeDisplayText } from '../displayText.ts'

/**
 * Skill names we list. Stricter than Claude Code (which takes the
 * directory name or the frontmatter `name`): lowercase letters, digits,
 * `:`, `_` and `-`, at most 64 characters. Anything else is not listed, so a
 * name can never carry spaces, markup or a second command.
 */
export const SKILL_NAME = /^[a-z0-9][a-z0-9:_-]{0,63}$/

/** Lines of frontmatter read at most; beyond that the file is not a skill we list. */
export const MAX_FRONTMATTER_LINES = 200

/** Longest description kept (Claude Code truncates its listing at 1,536). */
const MAX_DESCRIPTION_LENGTH = 1536

export interface SkillFrontmatter {
  readonly name?: string
  readonly description?: string
  /** `user-invocable: false` hides a skill from the `/` menu. */
  readonly userInvocable?: boolean
}

export interface Skill {
  readonly name: string
  /** Sanitized, one line; empty when the skill has none. */
  readonly description: string
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/
const BLOCK_SCALAR = /^[|>][+-]?$/

/**
 * A tiny, safe reader for the YAML frontmatter of a `SKILL.md`: only
 * top-level `key: value` lines, quoted or plain scalars and `|`/`>` blocks.
 * No YAML features beyond that (anchors, tags, flow collections are read as
 * plain text or ignored); nothing is evaluated. The frontmatter must start on
 * the first line, as Claude Code requires. No frontmatter: no fields.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trimEnd() !== '---') return {}
  const fields = new Map<string, string>()
  let closed = false
  const limit = Math.min(lines.length, MAX_FRONTMATTER_LINES + 1)
  for (let i = 1; i < limit; i++) {
    const line = lines[i] ?? ''
    if (line.trimEnd() === '---') {
      closed = true
      break
    }
    const match = KEY_LINE.exec(line)
    const key = match?.[1]
    if (key === undefined) continue
    const raw = (match?.[2] ?? '').trim()
    if (BLOCK_SCALAR.test(raw)) {
      const block: string[] = []
      // The block is every following line that is indented or blank.
      while (i + 1 < limit && /^(\s|$)/.test(lines[i + 1] ?? '')) {
        block.push((lines[i + 1] ?? '').trim())
        i++
      }
      fields.set(key, block.filter((part) => part !== '').join(' '))
    } else {
      fields.set(key, scalar(raw))
    }
  }
  if (!closed) return {}
  const name = fields.get('name')
  const description = fields.get('description')
  const invocable = fields.get('user-invocable')?.toLowerCase()
  return {
    ...(name === undefined || name === '' ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(invocable === 'false' ? { userInvocable: false } : {}),
  }
}

/**
 * The skill a `SKILL.md` in `<dir>/` stands for, or undefined when it is
 * not one we list: a name (frontmatter `name`, else the directory name) that
 * fails `SKILL_NAME`, or `user-invocable: false`.
 */
export function skillFromFile(dirName: string, text: string): Skill | undefined {
  const frontmatter = parseSkillFrontmatter(text)
  if (frontmatter.userInvocable === false) return undefined
  const name = frontmatter.name ?? dirName
  if (!SKILL_NAME.test(name)) return undefined
  return {
    name,
    description: sanitizeDisplayText(frontmatter.description ?? '', MAX_DESCRIPTION_LENGTH),
  }
}

/** A short, stable key for a skill name (FNV-1a, 32 bits, hex), small enough for button data. */
export function skillKey(name: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** A quoted scalar, possibly followed by a comment. */
const SINGLE_QUOTED = /^'((?:[^']|'')*)'(?:\s+#.*)?$/
const DOUBLE_QUOTED = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/

function scalar(raw: string): string {
  const single = SINGLE_QUOTED.exec(raw)
  if (single !== null) return (single[1] ?? '').replaceAll("''", "'")
  const double = DOUBLE_QUOTED.exec(raw)
  if (double !== null) return (double[1] ?? '').replace(/\\(["\\])/g, '$1')
  // A plain scalar ends at a comment.
  const comment = raw.search(/\s#/)
  return (comment === -1 ? raw : raw.slice(0, comment)).trim()
}
