import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import type { Clock } from '../../application/ports/Clock.ts'
import { isProcessAlive } from '../system/processAlive.ts'
import { DotEnvTokenStore } from './DotEnvTokenStore.ts'
import { JsonBotIdentityStore } from './JsonBotIdentityStore.ts'
import { SqliteAllowedSenderStore } from './SqliteAllowedSenderStore.ts'
import { SqliteAuditLog } from './SqliteAuditLog.ts'
import { SqlitePairingStore } from './SqlitePairingStore.ts'
import { SqlitePollerLock } from './SqlitePollerLock.ts'
import { DATABASE_FILE, openDatabase } from './sqlite.ts'
import { ensureStateDir } from './stateDir.ts'

/** Every store over one state directory, shared by the channel and the CLI. */
export interface StateStores {
  readonly db: Database
  readonly pairings: SqlitePairingStore
  readonly allowed: SqliteAllowedSenderStore
  readonly audit: SqliteAuditLog
  readonly lock: SqlitePollerLock
  readonly tokens: DotEnvTokenStore
  readonly identities: JsonBotIdentityStore
}

export function openState(
  stateDir: string,
  env: Readonly<Record<string, string | undefined>>,
  clock: Clock,
): StateStores {
  ensureStateDir(stateDir)
  const db = openDatabase(join(stateDir, DATABASE_FILE))
  return {
    db,
    pairings: new SqlitePairingStore(db),
    allowed: new SqliteAllowedSenderStore(db),
    audit: new SqliteAuditLog(db),
    lock: new SqlitePollerLock(db, { pid: process.pid, clock, isProcessAlive }),
    tokens: new DotEnvTokenStore(stateDir, env),
    identities: new JsonBotIdentityStore(stateDir),
  }
}
