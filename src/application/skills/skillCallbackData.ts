/** A skill by the key of its name, or a page of the list. */
export type SkillTap =
  | { readonly kind: 'skill'; readonly key: string }
  | { readonly kind: 'page'; readonly page: number }

/** Version 1 of `/skills` button data: `k1:<8 hex>` or `k1:p<page>`, at most 7 or 11 bytes. */
const CALLBACK_DATA = /^k1:(?:([0-9a-f]{8})|p([0-9]{1,3}))$/

export function encodeSkillCallback(tap: SkillTap): string {
  if (tap.kind === 'page') {
    if (!Number.isInteger(tap.page) || tap.page < 0 || tap.page > 999) throw new Error('bad page')
    return `k1:p${tap.page}`
  }
  if (!/^[0-9a-f]{8}$/.test(tap.key)) throw new Error('bad skill key')
  return `k1:${tap.key}`
}

/** Strict: anything that is not exactly what we encode is rejected. */
export function parseSkillCallback(data: string | undefined): SkillTap | undefined {
  const match = CALLBACK_DATA.exec(data ?? '')
  if (match === null) return undefined
  if (match[1] !== undefined) return { kind: 'skill', key: match[1] }
  return { kind: 'page', page: Number(match[2]) }
}
