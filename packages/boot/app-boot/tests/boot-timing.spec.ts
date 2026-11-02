import { describe, expect, it } from 'vitest'
import { BootTiming } from '../src/boot-timing.ts'

describe('BootTiming', () => {
  it('records phase durations as gaps between marks and reports one line', () => {
    const ticks = [120, 1200, 1240]
    const timing = new BootTiming(() => ticks.shift()!)
    timing.mark('heal')
    timing.mark('compose')
    timing.mark('mount')

    expect(timing.phases()).toEqual([
      { phase: 'heal', atMs: 120, durationMs: 120 },
      { phase: 'compose', atMs: 1200, durationMs: 1080 },
      { phase: 'mount', atMs: 1240, durationMs: 40 },
    ])
    expect(timing.totalMs).toBe(1240)
    expect(timing.format()).toBe('heal=120ms compose=1080ms mount=40ms total=1240ms')
  })

  it('starts empty and reports a zero total', () => {
    const timing = new BootTiming(() => 5)
    expect(timing.phases()).toEqual([])
    expect(timing.format()).toBe('total=0ms')
  })
})
