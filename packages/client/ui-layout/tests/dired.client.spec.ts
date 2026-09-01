/** Pure dired helpers: sort cycle/order, dotfile filter, formatting, ido flex match, parent paths. */

import { describe, expect, it } from 'vitest'
import {
  diredBack, diredForward, filterDired, flexDiredMatch, formatDiredDate, formatDiredMode, formatDiredSize,
  freshDiredHistory, nextDiredSort, parentOf, pushDiredLevel, sortDired, type DiredEntry,
} from '../src/client/dired.ts'

const row = (name: string, extra: Partial<DiredEntry> = {}): DiredEntry => ({
  name, path: `/home/${name}`, hidden: name.startsWith('.'), ...extra,
})
const rows: DiredEntry[] = [
  row('zeta.txt', { size: 30, modified: 100 }),
  row('.dot', { size: 5, modified: 300 }),
  row('alpha.md', { size: 20, modified: 200 }),
  row('Beta', { size: 10, modified: 50 }),
]



describe('dired formatting + ido matching', () => {
  it('flexDiredMatch keeps rows whose name carries every query character in order', () => {

    expect(flexDiredMatch(rows, '').length).toBe(4)
    expect(flexDiredMatch(rows, 'TA').map(e => e.name)).toEqual(['zeta.txt', 'alpha.md'])
    expect(flexDiredMatch(rows, 'zzz')).toEqual([])

    // Case-insensitive with in-order characters (not substrings).
    expect(flexDiredMatch(rows, 'bt').map(e => e.name)).toEqual(['Beta'])

  })

  it('formatDiredMode renders the type nibble and the rwx triples', () => {

    expect(formatDiredMode(0o040755)).toBe('drwxr-xr-x')
    expect(formatDiredMode(0o100644)).toBe('-rw-r--r--')
    expect(formatDiredMode(0o120777)).toBe('lrwxrwxrwx')
    expect(formatDiredMode(undefined)).toBe('')
  })


  it('formatDiredSize goes raw below 1k then one-decimal units', () => {

    expect(formatDiredSize(0)).toBe('0')
    expect(formatDiredSize(1023)).toBe('1023')
    expect(formatDiredSize(1024)).toBe('1.0k')
    expect(formatDiredSize(3146)).toBe('3.1k')
    expect(formatDiredSize(5 * 1024 * 1024)).toBe('5.0M')
    expect(formatDiredSize(undefined)).toBe('')
  })

  it('formatDiredDate shows a time this year and the year for older rows', () => {

    const now = new Date()
    const thisYear = new Date(now.getFullYear(), 7, 29, 19, 40)
    expect(formatDiredDate(thisYear.getTime())).toContain('Aug 29 19:40')

    const old = new Date(2020, 0, 2, 3, 4)

    expect(formatDiredDate(old.getTime())).toBe('Jan  2  2020')

    expect(formatDiredDate(undefined)).toBe('')

  })
})

describe('dired helpers', () => {
  it('nextDiredSort cycles name → size → modified → name', () => {
    expect(nextDiredSort('name')).toBe('size')
    expect(nextDiredSort('size')).toBe('modified')
    expect(nextDiredSort('modified')).toBe('name')
  })

  it('sortDired orders by the key case-insensitively', () => {

    expect(sortDired(rows, 'name', false).map(e => e.name)).toEqual(['.dot', 'alpha.md', 'Beta', 'zeta.txt'])
    expect(sortDired(rows, 'name', true).map(e => e.name)).toEqual(['zeta.txt', 'Beta', 'alpha.md', '.dot'])
  })

  it('sortDired orders by size and modified, missing values last', () => {

    const noStat = [row('b'), row('a', { size: 1 }), row('c', { size: 2 })]
    expect(sortDired(noStat, 'size', false).map(e => e.name)).toEqual(['a', 'c', 'b'])
    expect(sortDired(rows, 'modified', false).map(e => e.name)).toEqual(['Beta', 'zeta.txt', 'alpha.md', '.dot'])
  })

  it('sortDired never mutates its input', () => {
    const snapshot = [...rows]
    sortDired(rows, 'size', false)
    expect(rows).toEqual(snapshot)
  })

  it('filterDired hides dotfiles until shown', () => {

    expect(filterDired(rows, false).map(e => e.name)).toEqual(['zeta.txt', 'alpha.md', 'Beta'])
    expect(filterDired(rows, true)).toHaveLength(4)
  })

  it('parentOf walks up and stops at the root', () => {
    expect(parentOf('/home/user')).toBe('/home')
    expect(parentOf('/home')).toBe('/')
    expect(parentOf('/')).toBeUndefined()
    expect(parentOf('')).toBeUndefined()
    expect(parentOf('/home/user/')).toBe('/home')
  })
})

describe('dired history', () => {  it('push records levels and drops the forward stack (no branching)', () => {
  let h = freshDiredHistory(undefined)
  h = pushDiredLevel(h, '/home')
  h = pushDiredLevel(h, '/home/src')
  h = pushDiredLevel(h, '/home/src/packages')
  expect(h.levels).toEqual([undefined, '/home', '/home/src', '/home/src/packages'])
  expect(h.index).toBe(3)
  // Back twice, then a new branch: the forward levels are gone.
  h = diredBack(h)!
  h = diredBack(h)!
  h = pushDiredLevel(h, '/etc')
  expect(h.levels).toEqual([undefined, '/home', '/etc'])
  expect(h.index).toBe(2)
})

it('back/forward return null at the ends and never mutate', () => {
  const h = freshDiredHistory('/')
  expect(diredBack(h)).toBeNull()
  expect(diredForward(h)).toBeNull()
  const two = pushDiredLevel(h, '/tmp')
  // Back keeps the forward levels (that is what forward walks).
  expect(diredBack(two)).toEqual({ levels: ['/', '/tmp'], index: 0 })
  expect(diredForward(diredBack(two)!)).toEqual({ levels: ['/', '/tmp'], index: 1 })
  // Input untouched.
  expect(two.index).toBe(1)
})

it('re-navigating to the level on screen is a no-op (same reference)', () => {
  const h = pushDiredLevel(freshDiredHistory(undefined), '/home')
  expect(pushDiredLevel(h, '/home')).toBe(h)
})
})
