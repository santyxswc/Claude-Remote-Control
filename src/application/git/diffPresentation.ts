import { sanitizeDisplayText } from '../../domain/displayText.ts'
import type { GitStatus } from '../../domain/git/gitOutput.ts'
import type { GitStatusLineView, Messages } from '../i18n/messages.ts'
import type { GitChanges } from '../ports/GitRepository.ts'
import type { PromptKeyboard } from '../ports/PromptGateway.ts'
import { encodeGitCallback } from './gitCallbackData.ts'

/** The `.diff` document's size cap, note included (Telegram allows 50 MB; a phone does not need more). */
export const MAX_DIFF_DOCUMENT_BYTES = 5_000_000
/** Untracked paths listed in the document at most. */
export const MAX_UNTRACKED_LISTED = 2_000

/** Commit, Revert, Open PR, stamped with the time they were issued. */
export function gitActionsKeyboard(
  messages: Pick<Messages, 'gitActionButtons'>,
  now: number,
): PromptKeyboard {
  const labels = messages.gitActionButtons
  return [
    [
      { label: labels.commit, data: encodeGitCallback('commit', now) },
      { label: labels.revert, data: encodeGitCallback('revert', now) },
    ],
    [{ label: labels.pr, data: encodeGitCallback('pr', now) }],
  ]
}

/** The second step of Revert. */
export function revertConfirmKeyboard(
  messages: Pick<Messages, 'gitActionButtons'>,
  now: number,
): PromptKeyboard {
  const labels = messages.gitActionButtons
  return [
    [{ label: labels.confirmRevert, data: encodeGitCallback('confirm_revert', now) }],
    [{ label: labels.cancel, data: encodeGitCallback('cancel_revert', now) }],
  ]
}

export function gitStatusLine(status: GitStatus): Extract<GitStatusLineView, { kind: 'repo' }> {
  return {
    kind: 'repo',
    branch: status.branch,
    ahead: status.upstream?.ahead,
    behind: status.upstream?.behind,
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked.length,
    conflicted: status.conflicted,
  }
}

/**
 * The document: staged patch, unstaged patch, then the untracked paths, each
 * under a heading. Built from git's output as is; the outbound pipeline
 * redacts it before anything is cut or sent.
 */
export function renderDiffDocument(
  status: GitStatus,
  changes: GitChanges,
  labels: Messages['diffDocument'],
): string {
  const parts: string[] = []
  const section = (heading: string, patch: GitChanges['staged']['patch']) => {
    if (patch.text === '') return
    parts.push(heading, ending(patch.text))
    if (patch.cut) parts.push(`${labels.cutWhileReading(MAX_DIFF_DOCUMENT_BYTES / 1_000_000)}\n`)
  }
  section(`${labels.staged}\n`, changes.staged.patch)
  section(`${labels.unstaged}\n`, changes.unstaged.patch)
  if (status.untracked.length > 0) {
    const listed = status.untracked.slice(0, MAX_UNTRACKED_LISTED)
    const more = status.untracked.length - listed.length
    parts.push(
      `${labels.untracked}\n`,
      // A file name may hold a newline or controls; each is listed on one plain line.
      ...listed.map((path) => `${sanitizeDisplayText(path, 1024)}\n`),
      ...(more > 0 ? [`… +${more}\n`] : []),
    )
  }
  return parts.join('')
}

function ending(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}
