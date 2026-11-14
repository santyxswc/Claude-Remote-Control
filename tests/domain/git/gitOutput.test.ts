/** Parsing read-only git output (F8). */
import { describe, expect, test } from 'bun:test'
import {
  addTotals,
  NO_CHANGES,
  parseNumstat,
  parseStatusPorcelainV2,
} from '../../../src/domain/git/gitOutput.ts'

const z = (...records: string[]) => `${records.join('\0')}\0`

describe('parseStatusPorcelainV2', () => {
  test('branch, upstream and every kind of entry', () => {
    const status = parseStatusPorcelainV2(
      z(
        '# branch.oid 0123456789abcdef0123456789abcdef01234567',
        '# branch.head feat/x',
        '# branch.upstream origin/feat/x',
        '# branch.ab +2 -3',
        '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
        '1 .M N... 100644 100644 100644 aaa bbb unstaged.ts',
        '1 MM N... 100644 100644 100644 aaa bbb both.ts',
        '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts',
        'old.ts',
        'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
        '? new dir/',
        '? note.txt',
        '! ignored.log',
        'x some future record',
      ),
    )
    expect(status).toEqual({
      branch: 'feat/x',
      detached: false,
      upstream: { name: 'origin/feat/x', ahead: 2, behind: 3 },
      staged: 3,
      unstaged: 2,
      conflicted: 1,
      untracked: ['new dir/', 'note.txt'],
    })
  })

  test('detached, no upstream, empty', () => {
    expect(parseStatusPorcelainV2(z('# branch.oid abc', '# branch.head (detached)'))).toEqual({
      branch: undefined,
      detached: true,
      upstream: undefined,
      staged: 0,
      unstaged: 0,
      conflicted: 0,
      untracked: [],
    })
    expect(parseStatusPorcelainV2('').branch).toBeUndefined()
  })

  test('the original path of a rename is never read as an entry', () => {
    // An original path that looks like a record must not be counted.
    const status = parseStatusPorcelainV2(z('2 R. N... 1 1 1 a b R100 x', '? trick'))
    expect(status.untracked).toEqual([])
    expect(status.staged).toBe(1)
  })

  test('a malformed ahead/behind line is ignored', () => {
    const status = parseStatusPorcelainV2(
      z('# branch.head main', '# branch.upstream o/main', '# branch.ab +x -1'),
    )
    expect(status.upstream).toEqual({ name: 'o/main', ahead: 0, behind: 0 })
  })
})

describe('parseNumstat', () => {
  test('text, binary and renamed files', () => {
    expect(
      parseNumstat(z('3\t1\ta.ts', '-\t-\timage.png', '0\t0\t', 'old.ts', 'new.ts', '10\t2\tb.ts')),
    ).toEqual({ files: 4, insertions: 13, deletions: 3, binary: 1 })
  })

  test('nothing', () => {
    expect(parseNumstat('')).toEqual(NO_CHANGES)
  })

  test('a rename whose paths look like numstat records is not double counted', () => {
    expect(parseNumstat(z('1\t1\t', '9\t9\tx', '9\t9\ty'))).toEqual({
      files: 1,
      insertions: 1,
      deletions: 1,
      binary: 0,
    })
  })

  test('addTotals', () => {
    expect(
      addTotals(
        { files: 1, insertions: 2, deletions: 3, binary: 0 },
        { files: 2, insertions: 1, deletions: 0, binary: 1 },
      ),
    ).toEqual({ files: 3, insertions: 3, deletions: 3, binary: 1 })
  })
})
