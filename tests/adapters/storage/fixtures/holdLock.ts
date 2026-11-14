/**
 * Test fixture run as a separate process: takes the poller lock in the given
 * database, writes audit rows while the parent writes too, then idles until
 * killed. Prints `locked` and `written` as it goes. Usage: bun holdLock.ts <db path> <row count>
 */

import { SqliteAuditLog } from '../../../../src/adapters/storage/SqliteAuditLog.ts'
import { SqlitePollerLock } from '../../../../src/adapters/storage/SqlitePollerLock.ts'
import { openDatabase } from '../../../../src/adapters/storage/sqlite.ts'
import { isProcessAlive } from '../../../../src/adapters/system/processAlive.ts'

const [dbPath = '', rows = '0'] = process.argv.slice(2)
const db = openDatabase(dbPath)
const lock = new SqlitePollerLock(db, {
  pid: process.pid,
  clock: { now: Date.now },
  isProcessAlive,
})
if (!lock.tryAcquire('channel').acquired) process.exit(3)
process.stdout.write('locked\n')

const audit = new SqliteAuditLog(db)
for (let i = 0; i < Number(rows); i++) {
  audit.append({ at: i, actor: 'child', event: 'sender.revoked', details: {} })
  await Bun.sleep(0)
}
process.stdout.write('written\n')
setInterval(() => lock.refresh(), 1000)
// Never outlive a crashed test run.
setTimeout(() => process.exit(0), 30_000)
