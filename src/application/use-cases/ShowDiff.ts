import { type DiffPathProblem, parseDiffPathFilter } from '../../domain/git/diffPathFilter.ts'
import { addTotals } from '../../domain/git/gitOutput.ts'
import {
  gitActionsKeyboard,
  gitStatusLine,
  MAX_DIFF_DOCUMENT_BYTES,
  renderDiffDocument,
} from '../git/diffPresentation.ts'
import type { Messages } from '../i18n/messages.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { Clock } from '../ports/Clock.ts'
import type { DocumentGateway } from '../ports/DocumentGateway.ts'
import type { GitRepository } from '../ports/GitRepository.ts'
import type { Logger } from '../ports/Logger.ts'
import type { PromptGateway } from '../ports/PromptGateway.ts'
import { type AuthorizeReplyTarget, auditableChatId } from './AuthorizeReplyTarget.ts'

export interface DiffRequest {
  readonly chatId: string
  /** `telegram:<id>`. */
  readonly actor: string
  /** The raw argument of `/diff`; empty for the whole tree. */
  readonly path: string
}

export type DiffOutcome =
  | {
      readonly status: 'sent'
      readonly files: number
      readonly bytes: number
      readonly cut: boolean
      readonly redactions: number
    }
  | {
      readonly status: 'no_changes'
      readonly branch: string | undefined
      readonly pathFilter: string | undefined
    }
  | { readonly status: 'invalid_path'; readonly problem: DiffPathProblem }
  | {
      readonly status: 'refused'
      readonly reason: 'chat_not_allowed' | 'busy' | 'not_a_repo' | 'git_missing' | 'unsafe_config'
    }
  | { readonly status: 'failed'; readonly error: string }

export type DiffStart =
  | { readonly started: false; readonly outcome: DiffOutcome }
  | { readonly started: true; readonly done: Promise<DiffOutcome> }

export interface ShowDiffDeps {
  readonly git: GitRepository
  /** Must be the decorated gateway from `buildOutbound`: the diff is redacted before it is cut. */
  readonly documents: DocumentGateway
  readonly prompts: Pick<PromptGateway, 'sendPrompt'>
  readonly target: AuthorizeReplyTarget
  /** The project's name, for the caption. */
  readonly project: string | undefined
  readonly messages: Pick<
    Messages,
    'diffSummary' | 'diffDocument' | 'gitActionsPrompt' | 'gitActionButtons'
  >
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
}

/**
 * `/diff [path]` (F8): reads the work tree (read-only git), then sends the
 * staged and unstaged diff plus the untracked paths as a `.diff` document,
 * captioned with a short summary, and the Commit / Revert / Open PR buttons
 * below it. Nothing is sent when there are no changes. The path filter is
 * checked before any process runs. One at a time; `start` answers refusals
 * at once and runs the rest in the background (M1), and `stop` cancels it.
 * Audit rows carry counts and sizes only, never paths or content.
 */
export class ShowDiff {
  #running: { readonly abort: AbortController; readonly done: Promise<DiffOutcome> } | undefined

  constructor(private readonly deps: ShowDiffDeps) {}

  start(request: DiffRequest): DiffStart {
    if (!this.deps.target.execute(request.chatId)) {
      return this.#refuse(request, { status: 'refused', reason: 'chat_not_allowed' })
    }
    let pathFilter: string | undefined
    if (request.path !== '') {
      const parsed = parseDiffPathFilter(request.path)
      if (!parsed.ok)
        return this.#refuse(request, { status: 'invalid_path', problem: parsed.problem })
      pathFilter = parsed.path
    }
    if (this.#running !== undefined) {
      return this.#refuse(request, { status: 'refused', reason: 'busy' })
    }
    const abort = new AbortController()
    const done = this.#run(request, pathFilter, abort.signal)
      .catch((error: unknown): DiffOutcome => ({ status: 'failed', error: message(error) }))
      .then((outcome) => this.#finish(request, outcome))
      .finally(() => {
        this.#running = undefined
      })
    this.#running = { abort, done }
    return { started: true, done }
  }

  /** Cancels the read in flight (its git process is killed) and waits for it. */
  async stop(): Promise<void> {
    const running = this.#running
    if (running === undefined) return
    running.abort.abort()
    await running.done
  }

  async #run(
    request: DiffRequest,
    pathFilter: string | undefined,
    signal: AbortSignal,
  ): Promise<DiffOutcome> {
    const { deps } = this
    const read = await deps.git.read({
      withChanges: true,
      signal,
      ...(pathFilter === undefined ? {} : { pathFilter }),
    })
    if (read.kind === 'not_a_repo') return { status: 'refused', reason: 'not_a_repo' }
    if (read.kind === 'unavailable') return { status: 'refused', reason: read.reason }
    const { status, changes } = read
    if (changes === undefined) throw new Error('git returned no changes')
    if (
      changes.staged.patch.text === '' &&
      changes.unstaged.patch.text === '' &&
      status.untracked.length === 0
    ) {
      return { status: 'no_changes', branch: status.branch, pathFilter }
    }
    const totals = addTotals(changes.staged.totals, changes.unstaged.totals)
    const caption = deps.messages.diffSummary({
      project: deps.project,
      status: gitStatusLine(status),
      files: totals.files,
      insertions: totals.insertions,
      deletions: totals.deletions,
      binary: totals.binary,
      pathFilter,
    })
    const receipt = await deps.documents.sendDocument(
      request.chatId,
      {
        filename: 'changes.diff',
        text: renderDiffDocument(status, changes, deps.messages.diffDocument),
        maxBytes: MAX_DIFF_DOCUMENT_BYTES,
        cutNote: deps.messages.diffDocument.cutToFit(MAX_DIFF_DOCUMENT_BYTES / 1_000_000),
      },
      caption,
    )
    await deps.prompts.sendPrompt(
      request.chatId,
      deps.messages.gitActionsPrompt,
      gitActionsKeyboard(deps.messages, deps.clock.now()),
    )
    return {
      status: 'sent',
      files: totals.files,
      bytes: receipt.bytes,
      cut: receipt.cut || changes.staged.patch.cut || changes.unstaged.patch.cut,
      redactions: receipt.redactions,
    }
  }

  #refuse(request: DiffRequest, outcome: DiffOutcome): DiffStart {
    return { started: false, outcome: this.#finish(request, outcome) }
  }

  #finish(request: DiffRequest, outcome: DiffOutcome): DiffOutcome {
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: request.actor,
      event: outcome.status === 'sent' ? 'git.diff_sent' : 'git.diff_not_sent',
      details: {
        chatId: auditableChatId(request.chatId),
        filtered: request.path !== '',
        outcome: outcome.status,
        ...(outcome.status === 'sent'
          ? {
              files: outcome.files,
              bytes: outcome.bytes,
              cut: outcome.cut,
              redactions: outcome.redactions,
            }
          : {}),
        ...(outcome.status === 'refused' ? { reason: outcome.reason } : {}),
        ...(outcome.status === 'invalid_path' ? { reason: outcome.problem } : {}),
      },
    })
    if (outcome.status === 'failed') {
      this.deps.logger.error('/diff failed', { error: outcome.error })
    } else {
      this.deps.logger.info('/diff', { outcome: outcome.status })
    }
    return outcome
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
