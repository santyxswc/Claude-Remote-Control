import type { Database } from 'bun:sqlite'
import type { PermissionStore } from '../../application/ports/PermissionStore.ts'
import {
  PermissionRequest,
  type PermissionSnapshot,
  type PermissionState,
  type PromptRef,
  type RiskLevel,
} from '../../domain/permissions/PermissionRequest.ts'

interface PermissionRow {
  id: string
  session: string
  tool_name: string
  description: string
  input_preview: string
  risk: string
  state: string
  created_at: number
  confirmation_requested_at: number | null
  decided_by: string | null
  decided_at: number | null
  prompts: string
  revision: number
}

const COLUMNS =
  'id, session, tool_name, description, input_preview, risk, state, created_at, ' +
  'confirmation_requested_at, decided_by, decided_at, prompts, revision'

const OPEN_STATES = "('pending', 'awaiting_confirmation')"

type SqlValue = string | number | null

/**
 * Description and input preview stay on disk only while a request is open:
 * a closed row keeps the tool name, the outcome and who decided, nothing of
 * what the tool was asked to do.
 */
export class SqlitePermissionStore implements PermissionStore {
  constructor(private readonly db: Database) {}

  put(request: PermissionRequest): void {
    this.db
      .query(`INSERT OR REPLACE INTO permission_requests (${COLUMNS}) VALUES (${placeholders()})`)
      .run(...toRow(request.toSnapshot()))
  }

  update(next: PermissionRequest, expectedRevision: number): boolean {
    const [id, ...rest] = toRow(next.toSnapshot()) as [string, ...SqlValue[]]
    const result = this.db
      .query(
        `UPDATE permission_requests SET session = ?, tool_name = ?, description = ?,
           input_preview = ?, risk = ?, state = ?, created_at = ?, confirmation_requested_at = ?,
           decided_by = ?, decided_at = ?, prompts = ?, revision = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(...rest, id, expectedRevision)
    return result.changes === 1
  }

  findById(id: string): PermissionRequest | undefined {
    const row = this.db
      .query<PermissionRow, [string]>(`SELECT ${COLUMNS} FROM permission_requests WHERE id = ?`)
      .get(id)
    return row === null ? undefined : fromRow(row)
  }

  listOpen(): readonly PermissionRequest[] {
    return this.db
      .query<PermissionRow, []>(
        `SELECT ${COLUMNS} FROM permission_requests WHERE state IN ${OPEN_STATES}
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

function toRow(s: PermissionSnapshot): SqlValue[] {
  const open = s.state === 'pending' || s.state === 'awaiting_confirmation'
  return [
    s.id,
    s.session,
    s.toolName,
    open ? s.description : '',
    open ? s.inputPreview : '',
    s.risk,
    s.state,
    s.createdAt,
    s.confirmationRequestedAt ?? null,
    s.decidedBy ?? null,
    s.decidedAt ?? null,
    JSON.stringify(s.prompts),
    s.revision,
  ]
}

function fromRow(row: PermissionRow): PermissionRequest {
  return PermissionRequest.restore({
    id: row.id,
    session: row.session,
    toolName: row.tool_name,
    description: row.description,
    inputPreview: row.input_preview,
    risk: row.risk as RiskLevel,
    state: row.state as PermissionState,
    createdAt: row.created_at,
    confirmationRequestedAt: row.confirmation_requested_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    prompts: parsePrompts(row.prompts),
    revision: row.revision,
  })
}

function parsePrompts(json: string): PromptRef[] {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    const { chatId, messageId } = item as Record<string, unknown>
    return typeof chatId === 'string' && typeof messageId === 'string'
      ? [{ chatId, messageId }]
      : []
  })
}
