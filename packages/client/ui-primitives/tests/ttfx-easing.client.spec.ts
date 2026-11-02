import { describe, expect, it } from 'vitest'
import { cubicBezier, ease, EasingTracker, SequenceEaser } from '../src/ttfx/easing.ts'

const EASINGS = [
  'linear', 'in_sine', 'out_sine', 'in_out_sine', 'in_quad', 'out_quad', 'in_out_quad',
  'in_cubic', 'out_cubic', 'in_out_cubic', 'in_quart', 'out_quart', 'in_out_quart',
  'in_quint', 'out_quint', 'in_out_quint', 'in_expo', 'out_expo', 'in_out_expo',
  'in_circ', 'out_circ', 'in_out_circ', 'in_back', 'out_back', 'in_out_back',
  'in_elastic', 'out_elastic', 'in_out_elastic', 'in_bounce', 'out_bounce', 'in_out_bounce',
] as const

describe('ttfx easing', () => {
  it('evaluates each named easing across endpoints and piecewise intervals', () => {
    for (const name of EASINGS) {
      for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
        expect(Number.isFinite(ease(name, progress)), `${name} at ${progress}`).toBe(true)
      }
    }
    expect(ease('in_expo', 0)).toBe(0)
    expect(ease('out_expo', 1)).toBe(1)
    expect(ease('in_out_expo', 0)).toBe(0)
    expect(ease('in_out_expo', 1)).toBe(1)
    expect(ease('in_elastic', 0)).toBe(0)
    expect(ease('in_elastic', 1)).toBe(1)
    expect(ease('out_elastic', 0)).toBe(0)
    expect(ease('out_elastic', 1)).toBe(1)
    expect(ease('in_out_elastic', 0)).toBe(0)
    expect(ease('in_out_elastic', 1)).toBe(1)
    expect(ease('not-an-easing', 0.37)).toBe(0.37)
  })

  it('solves cubic Béziers, honors endpoint clamps, and stops on a flat derivative', () => {
    expect(cubicBezier(0.25, 0.1, 0.25, 1, 0)).toBe(0)
    expect(cubicBezier(0.25, 0.1, 0.25, 1, 1)).toBe(1)
    expect(ease([0.25, 0.1, 0.25, 1], 0.5)).toBeGreaterThan(0.5)
    expect(cubicBezier(0, 0, 0, 1, 0.5)).toBeGreaterThan(0)
    expect(cubicBezier(0, 0, 0, 1, 0.0001)).toBeGreaterThan(0)
    expect(Number.isFinite(cubicBezier(1, 0, 0, 1, 0.5))).toBe(true)
  })

  it('tracks deltas, completion, clamping, and reset', () => {
    const tracker = new EasingTracker({ easeName: 'linear', totalSteps: 2, clamp: true })
    expect(tracker.complete).toBe(false)
    expect(tracker.easedValue).toBe(0)
    expect(tracker.stepDelta).toBe(0)
    expect(tracker.step()).toBe(0.5)
    expect(tracker.stepDelta).toBe(0.5)
    expect(tracker.step()).toBe(1)
    expect(tracker.complete).toBe(true)
    expect(tracker.step()).toBe(1)
    tracker.reset()
    expect(tracker.complete).toBe(false)
    expect(tracker.stepDelta).toBe(0)
    const back = new EasingTracker({ easeName: 'out_back', totalSteps: 2, clamp: true })
    expect(back.step()).toBe(1)
    expect(back.step()).toBe(1)
    const unbounded = new EasingTracker({ easeName: 'out_back', totalSteps: 2, clamp: false })
    expect(unbounded.step()).toBeGreaterThan(1)
    const negative = new EasingTracker({ easeName: 'in_back', totalSteps: 4, clamp: true })
    expect(negative.step()).toBe(0)
  })

  it('adds, removes, resequences, and resets sequence groups', () => {
    const groups = [[1], [2], [3], [4], [5], [6], [7], [8]]
    const sequence = new SequenceEaser(groups, [1 / 3, 2, 2 / 3, -3] as const, 4)
    expect(sequence.complete).toBe(false)
    const [firstAdded, firstRemoved] = sequence.step()
    expect(firstAdded.length).toBeGreaterThan(0)
    expect(firstRemoved).toEqual([])
    const [secondAdded, secondRemoved] = sequence.step()
    expect(secondAdded).toEqual([])
    expect(secondRemoved.length).toBeGreaterThan(0)
    const [thirdAdded, thirdRemoved] = sequence.step()
    expect(thirdAdded).toEqual([])
    expect(thirdRemoved).toEqual([])
    const [lastAdded, lastRemoved] = sequence.step()
    expect(lastAdded.length).toBeGreaterThan(0)
    expect(lastRemoved).toEqual([])
    expect(sequence.complete).toBe(true)
    sequence.resequence([[9], [10]])
    expect(sequence.complete).toBe(false)
    expect(sequence.step()).toEqual([[], []])
    sequence.reset()
    expect(sequence.complete).toBe(false)
    const empty = new SequenceEaser([], 'linear', 1)
    expect(empty.step()).toEqual([[], []])
  })
})
