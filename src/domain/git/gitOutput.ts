/**
 * Parsers for the machine-readable output of the read-only git commands
 * behind `/diff` and `/status` (F8): `git status --porcelain=v2 --branch -z`
 * and `git diff --numstat -z`. Pure; every value is untrusted (branch and
 * file names come from the repository).
 */

export interface GitStatus {
  /** `undefined` when detached or unknown. */
  readonly branch: string | undefined
  readonly detached: boolean
  /** Ahead/behind the upstream, from local refs only (no network). */
  readonly upstream:
    | { readonly name: string; readonly ahead: number; readonly behind: number }
    | undefined
  /** Entries with a change in the index (`X` of `XY` not `.`). */
  readonly staged: number
  /** Entries with a change in the working tree not yet staged (`Y` not `.`). */
  readonly unstaged: number
  readonly conflicted: number
  /** Untracked paths as git lists them (a directory ends with `/`). */
  readonly untracked: readonly string[]
}

/**
 * Parses porcelain v2 with `-z`: records end with NUL, and a rename or copy
 * (`2 ...`) is followed by one more record holding the original path.
 * Unknown record types are skipped, so a newer git does not break it.
 */
export function parseStatusPorcelainV2(text: string): GitStatus {
  let branch: string | undefined
  let detached = false
  let upstreamName: string | undefined
  let ahead = 0
  let behind = 0
  let staged = 0
  let unstaged = 0
  let conflicted = 0
  const untracked: string[] = []
  const records = text.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? ''
    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length)
      if (head === '(detached)') detached = true
      else branch = head
    } else if (record.startsWith('# branch.upstream ')) {
      upstreamName = record.slice('# branch.upstream '.length)
    } else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
      if (match !== null) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
    } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const xy = record.slice(2, 4)
      if (xy[0] !== '.') staged += 1
      if (xy[1] !== '.') unstaged += 1
      if (record.startsWith('2 ')) i += 1 // the original path
    } else if (record.startsWith('u ')) {
      conflicted += 1
    } else if (record.startsWith('? ')) {
      untracked.push(record.slice(2))
    }
  }
  return {
    branch,
    detached,
    upstream: upstreamName === undefined ? undefined : { name: upstreamName, ahead, behind },
    staged,
    unstaged,
    conflicted,
    untracked,
  }
}

export interface DiffTotals {
  readonly files: number
  readonly insertions: number
  readonly deletions: number
  /** Files git shows as binary (`-` counts): their content is never in the diff. */
  readonly binary: number
}

export const NO_CHANGES: DiffTotals = { files: 0, insertions: 0, deletions: 0, binary: 0 }

/**
 * Parses `--numstat -z`: `added\tdeleted\tpath\0`, or for a rename
 * `added\tdeleted\t\0old\0new\0`. Binary files count `-` for both.
 */
export function parseNumstat(text: string): DiffTotals {
  let files = 0
  let insertions = 0
  let deletions = 0
  let binary = 0
  const records = text.split('\0')
  for (let i = 0; i < records.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(records[i] ?? '')
    if (match === null) continue
    files += 1
    if (match[1] === '-' || match[2] === '-') binary += 1
    else {
      insertions += Number(match[1])
      deletions += Number(match[2])
    }
    if (match[3] === '') i += 2 // rename: the two paths follow
  }
  return { files, insertions, deletions, binary }
}

export function addTotals(a: DiffTotals, b: DiffTotals): DiffTotals {
  return {
    files: a.files + b.files,
    insertions: a.insertions + b.insertions,
    deletions: a.deletions + b.deletions,
    binary: a.binary + b.binary,
  }
}
