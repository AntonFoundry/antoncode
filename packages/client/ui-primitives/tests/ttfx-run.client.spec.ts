import { describe, expect, it } from 'vitest'
import type { GridCell } from '../src/ttfx/grid.ts'
import { RevealRunner, runEffect } from '../src/ttfx/run.ts'

describe('ttfx reveal runner', () => {
  const grid: GridCell[][] = [[{ sym: 'X', fg: [20, 40, 60], bg: [70, 80, 90] }]]

  it('advances a seeded effect and completes on null', () => {
    const runner = new RevealRunner(grid, { effect: 'decrypt', seed: 23 })
    let result = runner.next()
    let ticks = 0
    while (result !== null && ticks < 500) {
      result = runner.next()
      ticks += 1
    }
    expect(result).toBeNull()
    expect(ticks).toBeGreaterThan(0)
  })

  it('collects until completion or the supplied frame cap', () => {
    const limited = runEffect(grid, { effect: 'decrypt', seed: 23 }, 1)
    expect(limited).toHaveLength(1)
    const complete = runEffect(grid, { effect: 'decrypt', seed: 23 }, 500)
    expect(complete.length).toBeGreaterThan(1)
    const first = runEffect(grid, { effect: 'decrypt', seed: 23 }, 1)
    expect(complete[0]).toEqual(first[0])
  })
})
