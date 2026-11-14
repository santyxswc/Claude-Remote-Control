import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { SqliteAllowedSenderStore } from '../../../src/adapters/storage/SqliteAllowedSenderStore.ts'
import { SqliteAuditLog } from '../../../src/adapters/storage/SqliteAuditLog.ts'
import { SqlitePairingStore } from '../../../src/adapters/storage/SqlitePairingStore.ts'
import { openDatabase } from '../../../src/adapters/storage/sqlite.ts'
import { AwaitPairingClaim } from '../../../src/application/use-cases/AwaitPairingClaim.ts'
import { ClaimPairing } from '../../../src/application/use-cases/ClaimPairing.ts'
import { StartPairing } from '../../../src/application/use-cases/StartPairing.ts'
import { allowSender } from '../../../src/domain/AllowedSender.ts'
import { Pairing } from '../../../src/domain/Pairing.ts'
import {
  ALICE,
  FakeClock,
  FakeHasher,
  FakeSleeper,
  MALLORY,
  SequentialRandom,
} from '../../fakes.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

let dir: string
let open: Database[]

beforeEach(() => {
  dir = makeTempDir()
  open = []
})

afterEach(() => {
  for (const db of open) db.close()
  removeTempDir(dir)
})

function connect(): Database {
  const db = openDatabase(join(dir, 'bridge.sqlite'))
  open.push(db)
  return db
}

describe('SqlitePairingStore', () => {
  test('round-trips every field of a pairing', () => {
    const store = new SqlitePairingStore(connect())
    const pairing = Pairing.start({ id: 'p1', codeHash: 'h', now: 10 })
    store.insert(pairing)
    const claimed = pairing.claim(MALLORY, 20)
    expect(store.update(claimed)).toBe(true)

    expect(store.findById('p1')?.toSnapshot()).toEqual(claimed.toSnapshot())
    expect(store.findById('p1')?.claimant?.id).toBe('9007199254740993')
  })

  test('update is a compare-and-set on the revision', () => {
    const store = new SqlitePairingStore(connect())
    const pairing = Pairing.start({ id: 'p1', codeHash: 'h', now: 0 })
    store.insert(pairing)

    expect(store.update(pairing.claim(ALICE, 1))).toBe(true)
    // A writer that read revision 0 before the claim loses.
    expect(store.update(pairing.replace(1))).toBe(false)
    expect(store.findById('p1')?.state).toBe('claimed')
  })

  test('findActive returns the newest pending or claimed pairing', () => {
    const store = new SqlitePairingStore(connect())
    expect(store.findActive()).toBeUndefined()
    const old = Pairing.start({ id: 'old', codeHash: 'h', now: 0 })
    store.insert(old)
    store.update(old.replace(5))
    store.insert(Pairing.start({ id: 'new', codeHash: 'h', now: 5 }))
    expect(store.findActive()?.id).toBe('new')
  })
})

describe('SqliteAllowedSenderStore', () => {
  test('adds, lists, checks and removes, keeping 64-bit ids exact', () => {
    const store = new SqliteAllowedSenderStore(connect())
    store.add(allowSender(MALLORY, 2))
    store.add(allowSender({ ...ALICE, username: undefined }, 1))

    expect(store.list()).toEqual([
      { ...ALICE, username: undefined, addedAt: 1 },
      { ...MALLORY, addedAt: 2 },
    ])
    expect(store.has('9007199254740993')).toBe(true)
    expect(store.has('9007199254740992')).toBe(false)
    expect(store.remove(MALLORY.id)).toBe(true)
    expect(store.remove(MALLORY.id)).toBe(false)
  })

  test('re-adding refreshes the profile but keeps the original date', () => {
    const store = new SqliteAllowedSenderStore(connect())
    store.add(allowSender(ALICE, 1))
    store.add(allowSender({ ...ALICE, displayName: 'Alice B' }, 9))
    expect(store.list()).toEqual([{ ...ALICE, displayName: 'Alice B', addedAt: 1 }])
  })
})

test('two connections play CLI and channel: the CLI sees the claim the channel recorded', async () => {
  const clock = new FakeClock()
  const hasher = new FakeHasher()
  const cliDb = connect()
  const channelDb = connect()
  const cli = { pairings: new SqlitePairingStore(cliDb), audit: new SqliteAuditLog(cliDb) }
  const channel = {
    pairings: new SqlitePairingStore(channelDb),
    audit: new SqliteAuditLog(channelDb),
  }

  const started = new StartPairing({
    ...cli,
    random: new SequentialRandom(),
    hasher,
    clock,
    links: { linkFor: (code) => code },
  }).execute()
  const sleeper = new FakeSleeper(clock)
  sleeper.onSleep = () => {
    new ClaimPairing({ ...channel, hasher, clock }).execute({
      code: started.code,
      sender: ALICE,
      sentAt: clock.now(),
    })
  }

  const result = await new AwaitPairingClaim({ ...cli, clock, sleeper }).execute(started.pairingId)

  expect(result.state).toBe('claimed')
  expect(result.claimant).toEqual(ALICE)
  const events = cliDb
    .query<{ event: string }, []>('SELECT event FROM audit_log ORDER BY seq')
    .all()
  expect(events.map((e) => e.event)).toEqual(['pairing.started', 'pairing.claimed'])
})
