import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { SqliteAuditLog } from '../../../src/adapters/storage/SqliteAuditLog.ts'
import {
  LOCK_STALE_AFTER_MS,
  SqlitePollerLock,
} from '../../../src/adapters/storage/SqlitePollerLock.ts'
import { openDatabase } from '../../../src/adapters/storage/sqlite.ts'
import { isProcessAlive } from '../../../src/adapters/system/processAlive.ts'
import { FakeClock } from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

let dir: string
let dbPath: string
let open: Database[]
let clock: FakeClock
const alive = new Set<number>()

beforeEach(() => {
  dir = makeTempDir()
  dbPath = join(dir, 'bridge.sqlite')
  open = []
  clock = new FakeClock()
  alive.clear()
})

afterEach(() => {
  for (const db of open) db.close()
  removeTempDir(dir)
})

/** One lock per simulated process, each with its own connection. */
function lockFor(pid: number): SqlitePollerLock {
  const db = openDatabase(dbPath)
  open.push(db)
  alive.add(pid)
  return new SqlitePollerLock(db, { pid, clock, isProcessAlive: (p) => alive.has(p) })
}

test('the first process gets the lock; a second sees who holds it', () => {
  const channel = lockFor(100)
  const cli = lockFor(200)

  expect(channel.tryAcquire('channel')).toEqual({ acquired: true })
  expect(cli.tryAcquire('cli')).toEqual({
    acquired: false,
    holder: { pid: 100, role: 'channel', startedAt: clock.now() },
  })
})

test('released locks can be taken; release by a non-holder does nothing', () => {
  const a = lockFor(100)
  const b = lockFor(200)
  a.tryAcquire('channel')
  b.release()
  expect(b.tryAcquire('cli').acquired).toBe(false)
  a.release()
  expect(b.tryAcquire('cli').acquired).toBe(true)
})

test('a lock whose holder process died is stale and replaced', () => {
  const a = lockFor(100)
  const b = lockFor(200)
  a.tryAcquire('channel')
  alive.delete(100)
  expect(b.tryAcquire('cli')).toEqual({ acquired: true })
  expect(a.refresh()).toBe(false)
})

test('a lock without heartbeat is stale even if its pid looks alive (pid reuse)', () => {
  const a = lockFor(100)
  const b = lockFor(200)
  a.tryAcquire('channel')
  clock.advance(LOCK_STALE_AFTER_MS - 1)
  expect(b.tryAcquire('cli').acquired).toBe(false)
  clock.advance(1)
  expect(b.tryAcquire('cli').acquired).toBe(true)
})

test('heartbeats keep the lock fresh', () => {
  const a = lockFor(100)
  const b = lockFor(200)
  a.tryAcquire('channel')
  clock.advance(LOCK_STALE_AFTER_MS - 1)
  expect(a.refresh()).toBe(true)
  clock.advance(LOCK_STALE_AFTER_MS - 1)
  expect(b.tryAcquire('cli').acquired).toBe(false)
})

test('re-acquiring by the holder succeeds', () => {
  const a = lockFor(100)
  expect(a.tryAcquire('channel').acquired).toBe(true)
  expect(a.tryAcquire('channel').acquired).toBe(true)
})

test('across real processes: a live holder blocks, a killed one is detected as stale', async () => {
  const fixture = join(import.meta.dir, 'fixtures', 'holdLock.ts')
  const child = Bun.spawn([process.execPath, fixture, dbPath, '200'], {
    stdout: 'pipe',
    stderr: 'inherit',
  })
  try {
    const reader = child.stdout.getReader()
    let output = ''
    const waitFor = async (marker: string) => {
      while (!output.includes(marker)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`fixture exited early: ${output}`)
        output += new TextDecoder().decode(value)
      }
    }
    await waitFor('locked')

    const db = openDatabase(dbPath)
    open.push(db)
    const lock = new SqlitePollerLock(db, {
      pid: process.pid,
      clock: { now: Date.now },
      isProcessAlive,
    })
    expect(lock.tryAcquire('cli')).toMatchObject({ acquired: false, holder: { pid: child.pid } })

    // Concurrent writers wait on each other instead of failing with SQLITE_BUSY.
    const audit = new SqliteAuditLog(db)
    for (let i = 0; i < 200; i++)
      audit.append({ at: i, actor: 'parent', event: 'sender.revoked', details: {} })

    await waitFor('written')
    reader.releaseLock()
    child.kill()
    await child.exited
    expect(lock.tryAcquire('cli')).toEqual({ acquired: true })
    const rows = db.query<{ actor: string; n: number }, []>(
      'SELECT actor, COUNT(*) AS n FROM audit_log GROUP BY actor ORDER BY actor',
    )
    expect(rows.all()).toEqual([
      { actor: 'child', n: 200 },
      { actor: 'parent', n: 200 },
    ])
  } finally {
    child.kill()
    await child.exited
  }
}, 20_000)
