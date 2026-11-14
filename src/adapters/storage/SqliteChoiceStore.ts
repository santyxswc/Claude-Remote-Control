import type { Database } from 'bun:sqlite'
import type { ChoiceStore } from '../../application/ports/ChoiceStore.ts'
import {
  Choice,
  type ChoiceAnswer,
  type ChoiceSnapshot,
  type ChoiceState,
} from '../../domain/choices/Choice.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'

interface ChoiceRow {
  id: string
  session: string
  chat_id: string
  question: string
  options: string
  allow_other: number
  state: string
  created_at: number
  answer: string | null
  answered_by: string | null
  closed_at: number | null
  prompt: string | null
  revision: number
}

const COLUMNS =
  'id, session, chat_id, question, options, allow_other, state, created_at, answer, ' +
  'answered_by, closed_at, prompt, revision'

type SqlValue = string | number | null

/**
 * The question and the labels stay on disk only while a choice is open: a
 * closed row keeps ids, the state, which option index and who answered.
 */
export class SqliteChoiceStore implements ChoiceStore {
  constructor(private readonly db: Database) {}

  put(choice: Choice): void {
    this.db
      .query(`INSERT OR REPLACE INTO choices (${COLUMNS}) VALUES (${placeholders()})`)
      .run(...toRow(choice.toSnapshot()))
  }

  update(next: Choice, expectedRevision: number): boolean {
    const [id, ...rest] = toRow(next.toSnapshot()) as [string, ...SqlValue[]]
    const result = this.db
      .query(
        `UPDATE choices SET session = ?, chat_id = ?, question = ?, options = ?, allow_other = ?,
           state = ?, created_at = ?, answer = ?, answered_by = ?, closed_at = ?, prompt = ?,
           revision = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(...rest, id, expectedRevision)
    return result.changes === 1
  }

  findById(id: string): Choice | undefined {
    const row = this.db
      .query<ChoiceRow, [string]>(`SELECT ${COLUMNS} FROM choices WHERE id = ?`)
      .get(id)
    return row === null ? undefined : fromRow(row)
  }

  listOpen(): readonly Choice[] {
    return this.db
      .query<ChoiceRow, []>(
        `SELECT ${COLUMNS} FROM choices WHERE state IN ('pending', 'awaiting_text')
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

function toRow(s: ChoiceSnapshot): SqlValue[] {
  const open = s.state === 'pending' || s.state === 'awaiting_text'
  return [
    s.id,
    s.session,
    s.chatId,
    open ? s.question : '',
    JSON.stringify(open ? s.options : []),
    s.allowOther ? 1 : 0,
    s.state,
    s.createdAt,
    s.answer === undefined ? null : JSON.stringify(s.answer),
    s.answeredBy ?? null,
    s.closedAt ?? null,
    s.prompt === undefined ? null : JSON.stringify(s.prompt),
    s.revision,
  ]
}

function fromRow(row: ChoiceRow): Choice {
  return Choice.restore({
    id: row.id,
    session: row.session,
    chatId: row.chat_id,
    question: row.question,
    options: parseOptions(row.options),
    allowOther: row.allow_other === 1,
    state: row.state as ChoiceState,
    createdAt: row.created_at,
    answer: parseAnswer(row.answer),
    answeredBy: row.answered_by ?? undefined,
    closedAt: row.closed_at ?? undefined,
    prompt: parsePrompt(row.prompt),
    revision: row.revision,
  })
}

function parseOptions(json: string): string[] {
  const value: unknown = JSON.parse(json)
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function parseAnswer(json: string | null): ChoiceAnswer | undefined {
  if (json === null) return undefined
  const value = JSON.parse(json) as { kind?: unknown; index?: unknown }
  if (value.kind === 'text') return { kind: 'text' }
  return value.kind === 'option' && typeof value.index === 'number'
    ? { kind: 'option', index: value.index }
    : undefined
}

function parsePrompt(json: string | null): PromptRef | undefined {
  if (json === null) return undefined
  const { chatId, messageId } = JSON.parse(json) as Record<string, unknown>
  return typeof chatId === 'string' && typeof messageId === 'string'
    ? { chatId, messageId }
    : undefined
}
