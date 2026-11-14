import type { Database } from 'bun:sqlite'
import type { VoiceTranscriptStore } from '../../application/ports/VoiceTranscriptStore.ts'
import type { PromptRef } from '../../domain/permissions/PermissionRequest.ts'
import {
  VoiceTranscript,
  type VoiceTranscriptSnapshot,
  type VoiceTranscriptState,
} from '../../domain/voice/VoiceTranscript.ts'

interface TranscriptRow {
  id: string
  session: string
  chat_id: string
  text: string
  length: number
  duration_seconds: number
  state: string
  created_at: number
  resolved_by: string | null
  closed_at: number | null
  prompt: string | null
  revision: number
}

const COLUMNS =
  'id, session, chat_id, text, length, duration_seconds, state, created_at, resolved_by, closed_at, prompt, revision'

type SqlValue = string | number | null

/**
 * The transcript stays on disk only while it is pending: a closed row keeps
 * ids, the state, the length and who answered. A sent transcript lives in the
 * session's conversation, not here.
 */
export class SqliteVoiceTranscriptStore implements VoiceTranscriptStore {
  constructor(private readonly db: Database) {}

  put(transcript: VoiceTranscript): void {
    this.db
      .query(`INSERT OR REPLACE INTO voice_transcripts (${COLUMNS}) VALUES (${placeholders()})`)
      .run(...toRow(transcript.toSnapshot()))
  }

  update(next: VoiceTranscript, expectedRevision: number): boolean {
    const [id, ...rest] = toRow(next.toSnapshot()) as [string, ...SqlValue[]]
    const result = this.db
      .query(
        `UPDATE voice_transcripts SET session = ?, chat_id = ?, text = ?, length = ?,
           duration_seconds = ?, state = ?, created_at = ?, resolved_by = ?, closed_at = ?,
           prompt = ?, revision = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(...rest, id, expectedRevision)
    return result.changes === 1
  }

  findById(id: string): VoiceTranscript | undefined {
    const row = this.db
      .query<TranscriptRow, [string]>(`SELECT ${COLUMNS} FROM voice_transcripts WHERE id = ?`)
      .get(id)
    return row === null ? undefined : fromRow(row)
  }

  listPending(): readonly VoiceTranscript[] {
    return this.db
      .query<TranscriptRow, []>(
        `SELECT ${COLUMNS} FROM voice_transcripts WHERE state = 'pending'
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

function toRow(s: VoiceTranscriptSnapshot): SqlValue[] {
  return [
    s.id,
    s.session,
    s.chatId,
    s.state === 'pending' ? s.text : '',
    s.length,
    s.durationSeconds,
    s.state,
    s.createdAt,
    s.resolvedBy ?? null,
    s.closedAt ?? null,
    s.prompt === undefined ? null : JSON.stringify(s.prompt),
    s.revision,
  ]
}

function fromRow(row: TranscriptRow): VoiceTranscript {
  return VoiceTranscript.restore({
    id: row.id,
    session: row.session,
    chatId: row.chat_id,
    text: row.text,
    length: row.length,
    durationSeconds: row.duration_seconds,
    state: row.state as VoiceTranscriptState,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by ?? undefined,
    closedAt: row.closed_at ?? undefined,
    prompt: parsePrompt(row.prompt),
    revision: row.revision,
  })
}

function parsePrompt(json: string | null): PromptRef | undefined {
  if (json === null) return undefined
  const { chatId, messageId } = JSON.parse(json) as Record<string, unknown>
  return typeof chatId === 'string' && typeof messageId === 'string'
    ? { chatId, messageId }
    : undefined
}
