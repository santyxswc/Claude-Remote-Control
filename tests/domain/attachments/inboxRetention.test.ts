import { expect, test } from 'bun:test'
import {
  DEFAULT_RETENTION,
  INBOX_QUOTA_BYTES,
  INBOX_TTL_MS,
  selectForDeletion,
} from '../../../src/domain/attachments/inboxRetention.ts'

const NOW = 1_700_000_000_000

test('defaults: 24 hours and 200 MB', () => {
  expect(INBOX_TTL_MS).toBe(24 * 60 * 60_000)
  expect(INBOX_QUOTA_BYTES).toBe(200_000_000)
  expect(DEFAULT_RETENTION).toEqual({ ttlMs: INBOX_TTL_MS, quotaBytes: INBOX_QUOTA_BYTES })
})

test('files past the TTL go', () => {
  const entries = [
    { name: 'old', bytes: 1, modifiedAt: NOW - INBOX_TTL_MS },
    { name: 'new', bytes: 1, modifiedAt: NOW - INBOX_TTL_MS + 1 },
    { name: 'future', bytes: 1, modifiedAt: NOW + 1000 },
  ]
  expect(selectForDeletion(entries, NOW)).toEqual(['old'])
})

test('then the oldest until the rest fits the quota', () => {
  const policy = { ttlMs: INBOX_TTL_MS, quotaBytes: 100 }
  const entries = [
    { name: 'b', bytes: 40, modifiedAt: NOW - 2 },
    { name: 'a', bytes: 40, modifiedAt: NOW - 3 },
    { name: 'c', bytes: 40, modifiedAt: NOW - 1 },
  ]
  expect(selectForDeletion(entries, NOW, policy)).toEqual(['a'])
  expect(selectForDeletion(entries, NOW, { ...policy, quotaBytes: 39 })).toEqual(['a', 'b', 'c'])
  expect(selectForDeletion([], NOW, policy)).toEqual([])
})
