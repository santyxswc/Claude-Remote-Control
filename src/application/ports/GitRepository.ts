import type { DiffTotals, GitStatus } from '../../domain/git/gitOutput.ts'

/** A patch as git printed it; `cut` when it was longer than the read cap (whole lines kept). */
export interface CapturedPatch {
  readonly text: string
  readonly cut: boolean
}

export interface GitChanges {
  readonly staged: { readonly totals: DiffTotals; readonly patch: CapturedPatch }
  readonly unstaged: { readonly totals: DiffTotals; readonly patch: CapturedPatch }
}

export type GitReadResult =
  /** Not inside a git working tree (or git refused the directory). */
  | { readonly kind: 'not_a_repo' }
  /** No usable git here: not installed, or a configuration the adapter cannot neutralize. */
  | { readonly kind: 'unavailable'; readonly reason: 'git_missing' | 'unsafe_config' }
  | {
      readonly kind: 'ok'
      readonly status: GitStatus
      /** Present when asked for (`withChanges`). */
      readonly changes?: GitChanges
    }

export interface GitReadRequest {
  /** A path already checked by `parseDiffPathFilter`; the whole tree when absent. */
  readonly pathFilter?: string
  /** Also read the staged and unstaged patches and their totals (`/diff`). */
  readonly withChanges: boolean
  readonly signal?: AbortSignal
}

/**
 * Reads the project's git working tree (F8). Read-only by construction: the
 * adapter can only run a fixed set of read-only git invocations, hardened
 * against repository configuration that runs programs. Every state change is
 * left to the session, as an instruction the owner sends. Rejects when git
 * fails, times out or is cancelled.
 */
export interface GitRepository {
  read(request: GitReadRequest): Promise<GitReadResult>
}
