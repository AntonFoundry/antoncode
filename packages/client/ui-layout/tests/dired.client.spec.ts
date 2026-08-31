/** Pure dired-lite helpers: sort cycle/order, dotfile filter, parent paths. */
import { describe, expect, it } from 'vitest'
import {
  filterDired, nextDiredSort, parentOf, sortDired, type DiredEntry,
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
