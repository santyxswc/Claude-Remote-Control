import {
  prepareSessionSummary,
  type SummaryProblem,
  summaryFileName,
  summarySlug,
} from '../../domain/sessions/sessionSummary.ts'
import { utf8Length } from '../../domain/utf8Length.ts'
import { ProjectFileError, type ProjectFileProblem } from '../errors.ts'
import type { SummarySavedView } from '../i18n/messages.ts'
import type { AuditLog } from '../ports/AuditLog.ts'
import type { ChatGateway } from '../ports/ChatGateway.ts'
import type { Clock } from '../ports/Clock.ts'
import type { Logger } from '../ports/Logger.ts'
import type { SessionSummaryStore } from '../ports/SessionSummaryStore.ts'
import { type AuthorizeReplyTarget, auditableChatId } from './AuthorizeReplyTarget.ts'

/** Summaries longer than this (in characters) are not repeated in the chat: about 4 messages. */
export const MAX_SUMMARY_CHAT_LENGTH = 16_000

/** What Claude passed to `save_session_summary`. Every field is untrusted. */
export interface SaveSummaryRequest {
  readonly chatId: string
  readonly title: string
  readonly markdown: string
}

export type SaveSummaryOutcome =
  | { readonly status: 'saved'; readonly path: string; readonly notified: boolean }
  | { readonly status: 'refused'; readonly reason: 'chat_not_allowed' }
  | { readonly status: 'invalid'; readonly problem: SummaryProblem }
  | { readonly status: 'not_saved'; readonly problem: ProjectFileProblem }

export interface SaveSessionSummaryDeps {
  readonly store: SessionSummaryStore
  /** The redacting, chunking text pipeline from `buildOutbound`. */
  readonly chat: ChatGateway
  /** The same chat rule as `reply`, without extra chats. */
  readonly target: AuthorizeReplyTarget
  readonly render: (view: SummarySavedView) => string
  readonly audit: AuditLog
  readonly clock: Clock
  readonly logger: Logger
}

/**
 * The `save_session_summary` tool (F12). The bridge writes the file, not
 * Claude: `<project>/docs/sessions/<UTC stamp>-<slug>.md`, never overwriting,
 * inside the project. Then the owner gets the path and the summary in the
 * chat (redacted there, like any text; the file itself is not). Audit rows
 * carry sizes and the outcome, never the title or the text.
 */
export class SaveSessionSummary {
  constructor(private readonly deps: SaveSessionSummaryDeps) {}

  async execute(request: SaveSummaryRequest): Promise<SaveSummaryOutcome> {
    const { logger } = this.deps
    if (!this.deps.target.execute(request.chatId)) {
      return this.#refuse(request, 'chat_not_allowed', {
        status: 'refused',
        reason: 'chat_not_allowed',
      })
    }
    const prepared = prepareSessionSummary(request.title, request.markdown)
    if (!prepared.ok) {
      return this.#refuse(request, prepared.problem, {
        status: 'invalid',
        problem: prepared.problem,
      })
    }
    const now = this.deps.clock.now()
    const slug = summarySlug(prepared.title)
    let path: string
    try {
      path = (
        await this.deps.store.save(
          (attempt) => summaryFileName(now, slug, attempt),
          prepared.document,
        )
      ).relativePath
    } catch (error) {
      const problem = error instanceof ProjectFileError ? error.problem : 'io'
      logger.error('could not save a session summary', { problem, error })
      return this.#refuse(request, problem, { status: 'not_saved', problem })
    }
    const document = prepared.document.trimEnd()
    let notified = true
    try {
      await this.deps.chat.sendText(
        request.chatId,
        this.deps.render({
          path,
          document: document.length > MAX_SUMMARY_CHAT_LENGTH ? undefined : document,
          length: document.length,
        }),
      )
    } catch (error) {
      notified = false
      logger.warn('the summary was saved but the chat notice failed', { error })
    }
    this.deps.audit.append({
      at: now,
      actor: 'session',
      event: 'session.summary_saved',
      details: {
        chatId: request.chatId,
        bytes: utf8Length(prepared.document),
        notified,
      },
    })
    logger.info('saved a session summary', { bytes: utf8Length(prepared.document), notified })
    return { status: 'saved', path, notified }
  }

  #refuse(
    request: SaveSummaryRequest,
    reason: string,
    outcome: SaveSummaryOutcome,
  ): SaveSummaryOutcome {
    this.deps.audit.append({
      at: this.deps.clock.now(),
      actor: 'session',
      event: 'session.summary_not_saved',
      details: { chatId: auditableChatId(request.chatId), reason },
    })
    this.deps.logger.warn('session summary not saved', { reason })
    return outcome
  }
}
