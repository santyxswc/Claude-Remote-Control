/**
 * `/diff` buttons (F8). `c` commit, `r` revert (asks first), `p` open a PR,
 * `y` confirm the revert, `x` cancel it. Each carries the second it was
 * issued, in base 36, so a stale button can be refused.
 */
export type GitButton = 'commit' | 'revert' | 'pr' | 'confirm_revert' | 'cancel_revert'

export interface GitTap {
  readonly button: GitButton
  /** Milliseconds since the epoch, to the second. */
  readonly issuedAt: number
}

const CODES: Readonly<Record<GitButton, string>> = {
  commit: 'c',
  revert: 'r',
  pr: 'p',
  confirm_revert: 'y',
  cancel_revert: 'x',
}

const BUTTONS: Readonly<Record<string, GitButton>> = {
  c: 'commit',
  r: 'revert',
  p: 'pr',
  y: 'confirm_revert',
  x: 'cancel_revert',
}

/** Version 1: `g1:<c|r|p|y|x>:<seconds in base 36>`, at most 15 bytes. Never a `p1:` verdict. */
const CALLBACK_DATA = /^g1:([crpyx]):([0-9a-z]{1,9})$/

export function encodeGitCallback(button: GitButton, issuedAt: number): string {
  const seconds = Math.floor(issuedAt / 1000)
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('bad issue time')
  return `g1:${CODES[button]}:${seconds.toString(36)}`
}

/** Strict: anything that is not exactly what we encode is rejected. */
export function parseGitCallback(data: string | undefined): GitTap | undefined {
  const match = CALLBACK_DATA.exec(data ?? '')
  const button = match?.[1] === undefined ? undefined : BUTTONS[match[1]]
  if (match === null || button === undefined) return undefined
  return { button, issuedAt: Number.parseInt(match[2] ?? '', 36) * 1000 }
}
