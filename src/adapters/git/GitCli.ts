import type {
  CapturedPatch,
  GitReadRequest,
  GitReadResult,
  GitRepository,
} from '../../application/ports/GitRepository.ts'
import { parseNumstat, parseStatusPorcelainV2 } from '../../domain/git/gitOutput.ts'
import { keepCompleteLines } from '../../domain/lineCut.ts'
import type { CapturedOutput, CapturingProcessRunner } from '../session/processRunner.ts'
import {
  filterNames,
  type GitInvocation,
  gitArgv,
  gitEnvironment,
  isOverridableFilterName,
} from './gitInvocations.ts'

/** Per git command; a huge repository may need a while for `status`. */
export const GIT_TIMEOUT_MS = 15_000
/** Read cap per patch (staged, unstaged); whole lines are kept. */
export const MAX_PATCH_BYTES = 5_000_000
/** Read cap for status and numstat listings. */
export const MAX_LISTING_BYTES = 1_000_000

export interface GitCliOptions {
  /** Absolute path of the git executable (resolved once at startup); undefined: not installed. */
  readonly gitPath: string | undefined
  /** The project directory git runs in. */
  readonly cwd: string
  /** The channel's environment; only a few variables are passed on (`gitEnvironment`). */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly devNull: string
  readonly run: CapturingProcessRunner
}

export class GitCommandError extends Error {
  constructor(invocation: GitInvocation, result: CapturedOutput) {
    super(
      result.timedOut
        ? `git ${invocation} timed out`
        : `git ${invocation} exited with ${String(result.exitCode)}`,
    )
    this.name = 'GitCommandError'
  }
}

const decoder = new TextDecoder('utf-8')

/**
 * The read-only git adapter (F8, ADR 0012). It can only run the fixed,
 * hardened invocations of `gitInvocations.ts`, in the project directory,
 * with a scrubbed environment, a timeout and an output cap.
 */
export class GitCli implements GitRepository {
  readonly #env: Record<string, string>

  constructor(private readonly options: GitCliOptions) {
    this.#env = gitEnvironment(options.env)
  }

  async read(request: GitReadRequest): Promise<GitReadResult> {
    if (this.options.gitPath === undefined) return { kind: 'unavailable', reason: 'git_missing' }
    const signal = request.signal
    const inside = await this.#run('is_work_tree', [], undefined, MAX_LISTING_BYTES, signal)
    if (inside.exitCode !== 0 || decoder.decode(inside.stdout).trim() !== 'true') {
      if (inside.timedOut) throw new GitCommandError('is_work_tree', inside)
      return { kind: 'not_a_repo' }
    }
    // Exit 1 means "no such key": no filter driver is configured.
    const listing = await this.#run('list_filters', [], undefined, MAX_LISTING_BYTES, signal)
    // A listing too long to read whole could hide a driver: refuse rather than guess.
    if (listing.truncated) return { kind: 'unavailable', reason: 'unsafe_config' }
    if (listing.exitCode !== 0 && listing.exitCode !== 1) {
      throw new GitCommandError('list_filters', listing)
    }
    const filters = filterNames(decoder.decode(listing.stdout))
    if (!filters.every(isOverridableFilterName)) {
      return { kind: 'unavailable', reason: 'unsafe_config' }
    }
    const path = request.pathFilter
    const status = await this.#run('status', filters, path, MAX_LISTING_BYTES, signal)
    if (status.exitCode !== 0 && !status.truncated) throw new GitCommandError('status', status)
    const statusText = decoder.decode(status.stdout)
    const parsed = parseStatusPorcelainV2(
      status.truncated ? statusText.slice(0, statusText.lastIndexOf('\0') + 1) : statusText,
    )
    if (!request.withChanges) return { kind: 'ok', status: parsed }

    const [stagedTotals, unstagedTotals, stagedPatch, unstagedPatch] = await Promise.all([
      this.#listing('staged_numstat', filters, path, signal),
      this.#listing('unstaged_numstat', filters, path, signal),
      this.#patch('staged_patch', filters, path, signal),
      this.#patch('unstaged_patch', filters, path, signal),
    ])
    return {
      kind: 'ok',
      status: parsed,
      changes: {
        staged: { totals: parseNumstat(stagedTotals), patch: stagedPatch },
        unstaged: { totals: parseNumstat(unstagedTotals), patch: unstagedPatch },
      },
    }
  }

  async #listing(
    invocation: GitInvocation,
    filters: readonly string[],
    path: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const result = await this.#run(invocation, filters, path, MAX_LISTING_BYTES, signal)
    if (result.exitCode !== 0 && !result.truncated) throw new GitCommandError(invocation, result)
    const text = decoder.decode(result.stdout)
    return result.truncated ? text.slice(0, text.lastIndexOf('\0') + 1) : text
  }

  /** A patch cut by the cap loses its partial last line before anything else sees it. */
  async #patch(
    invocation: GitInvocation,
    filters: readonly string[],
    path: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CapturedPatch> {
    const result = await this.#run(invocation, filters, path, MAX_PATCH_BYTES, signal)
    if (result.exitCode !== 0 && !result.truncated) throw new GitCommandError(invocation, result)
    const text = decoder.decode(result.stdout)
    return result.truncated ? { text: keepCompleteLines(text), cut: true } : { text, cut: false }
  }

  #run(
    invocation: GitInvocation,
    filters: readonly string[],
    pathFilter: string | undefined,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<CapturedOutput> {
    const argv = gitArgv(invocation, {
      devNull: this.options.devNull,
      filters,
      ...(pathFilter === undefined ? {} : { pathFilter }),
    })
    return this.options.run([this.options.gitPath ?? 'git', ...argv], {
      cwd: this.options.cwd,
      env: this.#env,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes,
      ...(signal === undefined ? {} : { signal }),
    })
  }
}
