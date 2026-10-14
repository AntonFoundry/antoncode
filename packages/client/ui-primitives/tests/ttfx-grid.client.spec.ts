import { describe, expect, it } from 'vitest'
import { Canvas, coordKey } from '../src/ttfx/grid.ts'
import type { CharGrouping, GridCell } from '../src/ttfx/grid.ts'
import { Rng } from '../src/ttfx/rng.ts'

const lines: GridCell[][] = [
  [{ sym: 'A', fg: [1, 2, 3], bg: null }, { sym: 'B', fg: null, bg: [4, 5, 6] }, { sym: ' ', fg: null, bg: null }],
  [{ sym: 'C', fg: [7, 8, 9], bg: [10, 11, 12] }, { sym: 'D', fg: [13, 14, 15], bg: null }, { sym: 'E', fg: null, bg: null }],
  [{ sym: 'F', fg: [16, 17, 18], bg: [19, 20, 21] }, { sym: 'G', fg: [22, 23, 24], bg: [25, 26, 27] }, { sym: 'H', fg: [28, 29, 30], bg: [31, 32, 33] }],
]

describe('ttfx character canvas', () => {
  it('lays out input, fills holes, truncates to bounds, and returns dense coordinates', () => {
    const canvas = new Canvas(2, 2, lines)
    expect([canvas.left, canvas.bottom, canvas.right, canvas.top]).toEqual([1, 1, 2, 2])
    expect([canvas.visibleLeft, canvas.visibleRight, canvas.visibleBottom, canvas.visibleTop]).toEqual([1, 2, 1, 2])
    expect(canvas.kept.length).toBeGreaterThan(0)
    expect(canvas.charByCoord(1, 1)).not.toBeNull()
    expect(canvas.charByCoord(2, 2)).not.toBeNull()
    expect(canvas.charByCoord(3, 3)).toBeNull()
    expect(canvas.allIds()).toEqual([...canvas.kept, ...canvas.fills])
    expect(canvas.renderAnims().every(anim => anim.id >= 0)).toBe(true)
    expect(canvas.fills.every(id => canvas.anims[id]?.isFill)).toBe(true)
    expect(canvas.textWidth).toBeGreaterThan(0)
    expect(canvas.textHeight).toBeGreaterThan(0)
    expect(() => new Canvas(2, 2, [[{ sym: ' ', fg: null, bg: null }]])).toThrow(/all input characters/)
  })

  it('groups every direction, reverses the requested orders, and handles empty subsets', () => {
    const canvas = new Canvas(3, 3, lines)
    const orders: CharGrouping[] = [
      'column_left_to_right', 'column_right_to_left', 'row_bottom_to_top', 'row_top_to_bottom',
      'diagonal_bottom_left_to_top_right', 'diagonal_top_right_to_bottom_left',
      'diagonal_top_left_to_bottom_right', 'diagonal_bottom_right_to_top_left', 'center_to_outside', 'outside_to_center',
    ]
    for (const order of orders) {
      const groups = canvas.groupedIds(order)
      expect(groups.flat().sort((a, b) => a - b), order).toEqual([...canvas.kept].sort((a, b) => a - b))
      expect(groups.every(group => group.length > 0), order).toBe(true)
    }
    expect(canvas.groupedIds('row_top_to_bottom')[0]).toEqual(canvas.groupedIds('row_bottom_to_top').at(-1))
    expect(canvas.groupedIds('column_right_to_left')[0]).toEqual(canvas.groupedIds('column_left_to_right').at(-1))
    expect(canvas.groupedIds('outside_to_center')[0]).toEqual(canvas.groupedIds('center_to_outside').at(-1))
    expect(canvas.groupedIds('column_left_to_right', [])).toEqual([])
    expect(canvas.orderedIds()).toHaveLength(canvas.kept.length)
    expect(canvas.orderedIds([])).toEqual([])
  })

  it('draws scoped and out-of-scope random coordinates from seeded streams', () => {
    const canvas = new Canvas(3, 3, lines)
    const inside = canvas.randomCoord(new Rng(4), false, true)
    expect(inside[0]).toBeGreaterThanOrEqual(canvas.textLeft)
    expect(inside[0]).toBeLessThanOrEqual(canvas.textRight)
    expect(inside[1]).toBeGreaterThanOrEqual(canvas.textBottom)
    expect(inside[1]).toBeLessThanOrEqual(canvas.textTop)
    const outside = canvas.randomCoord(new Rng(4), true, false)
    expect(outside[0] < canvas.left || outside[0] > canvas.right || outside[1] < canvas.bottom || outside[1] > canvas.top).toBe(true)
    expect(canvas.randomColumn(new Rng(2), false)).toBeGreaterThanOrEqual(1)
    expect(canvas.randomRow(new Rng(3), false)).toBeGreaterThanOrEqual(1)
  })

  it('clamps empty and one-cell bounds and keeps the row/column key contract', () => {
    const narrow = new Canvas(1, 1, lines)
    expect(narrow.charCount).toBe(1)
    expect(narrow.right).toBe(1)
    expect(narrow.top).toBe(1)
    expect(narrow.centerColumn).toBe(1)
    expect(narrow.centerRow).toBe(1)
    expect(coordKey(2, 3)).toBe(2_000_003)
  })
})
