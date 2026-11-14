import type { Database } from 'bun:sqlite'
import type { MemoryProposalStore } from '../../application/ports/MemoryProposalStore.ts'
import {
  MemoryProposal,
  type MemoryProposalSnapshot,
  type MemoryProposalState,
} from '../../domain/memory/MemoryProposal.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'

interface ProposalRow {
  id: string
  session: string
  chat_id: string
  lines: string
  line_count: number
  state: string
  created_at: number
  resolved_by: string | null
  closed_at: number | null
  prompt: string | null
  revision: number
}

const COLUMNS =
  'id, session, chat_id, lines, line_count, state, created_at, resolved_by, closed_at, prompt, revision'

type SqlValue = string | number | null

/**
 * The proposed lines stay on disk only while a proposal is pending: a closed
 * row keeps ids, the state, how many lines and who answered. Approved lines
 * live in `CLAUDE.md` itself.
 */
export class SqliteMemoryProposalStore implements MemoryProposalStore {
  constructor(private readonly db: Database) {}

  put(proposal: MemoryProposal): void {
    this.db
      .query(`INSERT OR REPLACE INTO memory_proposals (${COLUMNS}) VALUES (${placeholders()})`)
      .run(...toRow(proposal.toSnapshot()))
  }

  update(next: MemoryProposal, expectedRevision: number): boolean {
    const [id, ...rest] = toRow(next.toSnapshot()) as [string, ...SqlValue[]]
    const result = this.db
      .query(
        `UPDATE memory_proposals SET session = ?, chat_id = ?, lines = ?, line_count = ?,
           state = ?, created_at = ?, resolved_by = ?, closed_at = ?, prompt = ?, revision = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(...rest, id, expectedRevision)
    return result.changes === 1
  }

  findById(id: string): MemoryProposal | undefined {
    const row = this.db
      .query<ProposalRow, [string]>(`SELECT ${COLUMNS} FROM memory_proposals WHERE id = ?`)
      .get(id)
    return row === null ? undefined : fromRow(row)
  }

  listPending(): readonly MemoryProposal[] {
    return this.db
      .query<ProposalRow, []>(
        `SELECT ${COLUMNS} FROM memory_proposals WHERE state = 'pending'
         ORDER BY created_at, rowid`,
      )
      .all()
      .map(fromRow)
  }
}

function placeholders(): string {
  return COLUMNS.split(',')
    .map(() => '?')
    .join(', ')
}

function toRow(s: MemoryProposalSnapshot): SqlValue[] {
  return [
    s.id,
    s.session,
    s.chatId,
    JSON.stringify(s.state === 'pending' ? s.lines : []),
    s.lineCount,
    s.state,
    s.createdAt,
    s.resolvedBy ?? null,
    s.closedAt ?? null,
    s.prompt === undefined ? null : JSON.stringify(s.prompt),
    s.revision,
  ]
}

function fromRow(row: ProposalRow): MemoryProposal {
  return MemoryProposal.restore({
    id: row.id,
    session: row.session,
    chatId: row.chat_id,
    lines: parseLines(row.lines),
    lineCount: row.line_count,
    state: row.state as MemoryProposalState,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by ?? undefined,
    closedAt: row.closed_at ?? undefined,
    prompt: parsePrompt(row.prompt),
    revision: row.revision,
  })
}

function parseLines(json: string): string[] {
  const value: unknown = JSON.parse(json)
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function parsePrompt(json: string | null): PromptRef | undefined {
  if (json === null) return undefined
  const { chatId, messageId } = JSON.parse(json) as Record<string, unknown>
  return typeof chatId === 'string' && typeof messageId === 'string'
    ? { chatId, messageId }
    : undefined
}
