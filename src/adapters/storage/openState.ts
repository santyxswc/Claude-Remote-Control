import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import type { Clock } from '../../application/ports/Clock.ts'
import { isProcessAlive } from '../system/processAlive.ts'
import { DotEnvTokenStore } from './DotEnvTokenStore.ts'
import { FileBrakeFlag } from './FileBrakeFlag.ts'
import { JsonBotIdentityStore } from './JsonBotIdentityStore.ts'
import { SqliteAllowedSenderStore } from './SqliteAllowedSenderStore.ts'
import { SqliteAuditLog } from './SqliteAuditLog.ts'
import { SqliteChoiceStore } from './SqliteChoiceStore.ts'
import { SqliteMemoryProposalStore } from './SqliteMemoryProposalStore.ts'
import { SqlitePairingStore } from './SqlitePairingStore.ts'
import { SqlitePermissionStore } from './SqlitePermissionStore.ts'
import { SqlitePollerLock } from './SqlitePollerLock.ts'
import { SqliteStatusMessageStore } from './SqliteStatusMessageStore.ts'
import { SqliteVoiceTranscriptStore } from './SqliteVoiceTranscriptStore.ts'
import { DATABASE_FILE, openDatabase } from './sqlite.ts'
import { ensureStateDir } from './stateDir.ts'

/** Every store over one state directory, shared by the channel and the CLI. */
export interface StateStores {
  readonly db: Database
  readonly pairings: SqlitePairingStore
  readonly allowed: SqliteAllowedSenderStore
  readonly audit: SqliteAuditLog
  readonly lock: SqlitePollerLock
  readonly permissions: SqlitePermissionStore
  /** Questions asked with `ask_choice` (F7). */
  readonly choices: SqliteChoiceStore
  /** The pinned status message of each chat (F9). */
  readonly statusMessages: SqliteStatusMessageStore
  /** Lines proposed for `CLAUDE.md` with `propose_memory` (F12). */
  readonly memoryProposals: SqliteMemoryProposalStore
  /** Voice transcripts waiting for Send or Discard (F13). */
  readonly voiceTranscripts: SqliteVoiceTranscriptStore
  readonly tokens: DotEnvTokenStore
  readonly identities: JsonBotIdentityStore
  /** The panic brake (F6): a file, so the PreToolUse hook can read it without SQLite. */
  readonly brake: FileBrakeFlag
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
    permissions: new SqlitePermissionStore(db),
    choices: new SqliteChoiceStore(db),
    statusMessages: new SqliteStatusMessageStore(db),
    memoryProposals: new SqliteMemoryProposalStore(db),
    voiceTranscripts: new SqliteVoiceTranscriptStore(db),
    lock: new SqlitePollerLock(db, { pid: process.pid, clock, isProcessAlive }),
    tokens: new DotEnvTokenStore(stateDir, env),
    identities: new JsonBotIdentityStore(stateDir),
    brake: new FileBrakeFlag(stateDir),
  }
}
