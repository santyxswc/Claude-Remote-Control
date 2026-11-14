import type { Database } from 'bun:sqlite'
import type { PairingStore } from '../../application/ports/PairingStore.ts'
import {
  type CancelReason,
  Pairing,
  type PairingSnapshot,
  type PairingState,
} from '../../domain/Pairing.ts'

interface PairingRow {
  id: string
  state: string
  code_hash: string | null
  created_at: number
  expires_at: number
  failed_attempts: number
  claimant_id: string | null
  claimant_username: string | null
  claimant_display_name: string | null
  claimed_at: number | null
  ended_at: number | null
  cancel_reason: string | null
  revision: number
}

const COLUMNS =
  'id, state, code_hash, created_at, expires_at, failed_attempts, claimant_id, claimant_username, ' +
  'claimant_display_name, claimed_at, ended_at, cancel_reason, revision'

export class SqlitePairingStore implements PairingStore {
  constructor(private readonly db: Database) {}

  insert(pairing: Pairing): void {
    this.db
      .query(`INSERT INTO pairings (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...toRow(pairing.toSnapshot()))
  }

  update(next: Pairing): boolean {
    const [id, ...rest] = toRow(next.toSnapshot()) as [string, ...SqlValue[]]
    const result = this.db
      .query(
        `UPDATE pairings SET state = ?, code_hash = ?, created_at = ?, expires_at = ?,
           failed_attempts = ?, claimant_id = ?, claimant_username = ?, claimant_display_name = ?,
           claimed_at = ?, ended_at = ?, cancel_reason = ?, revision = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(...rest, id, next.revision - 1)
    return result.changes === 1
  }

  findById(id: string): Pairing | undefined {
    const row = this.db
      .query<PairingRow, [string]>(`SELECT ${COLUMNS} FROM pairings WHERE id = ?`)
      .get(id)
    return row === null ? undefined : fromRow(row)
  }

  findActive(): Pairing | undefined {
    const row = this.db
      .query<PairingRow, []>(
        `SELECT ${COLUMNS} FROM pairings WHERE state IN ('pending', 'claimed')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get()
    return row === null ? undefined : fromRow(row)
  }
}

type SqlValue = string | number | null

function toRow(s: PairingSnapshot): SqlValue[] {
  return [
    s.id,
    s.state,
    s.codeHash ?? null,
    s.createdAt,
    s.expiresAt,
    s.failedAttempts,
    s.claimant?.id ?? null,
    s.claimant?.username ?? null,
    s.claimant?.displayName ?? null,
    s.claimedAt ?? null,
    s.endedAt ?? null,
    s.cancelReason ?? null,
    s.revision,
  ]
}

function fromRow(row: PairingRow): Pairing {
  return Pairing.restore({
    id: row.id,
    state: row.state as PairingState,
    codeHash: row.code_hash ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    failedAttempts: row.failed_attempts,
    claimant:
      row.claimant_id === null
        ? undefined
        : {
            id: row.claimant_id,
            username: row.claimant_username ?? undefined,
            displayName: row.claimant_display_name ?? '',
          },
    claimedAt: row.claimed_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    cancelReason: (row.cancel_reason ?? undefined) as CancelReason | undefined,
    revision: row.revision,
  })
}
