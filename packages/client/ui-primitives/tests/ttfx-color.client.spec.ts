import { describe, expect, it } from 'vitest'
import { adjustBrightness, fromHex, Gradient, GradientMap } from '../src/ttfx/color.ts'

describe('ttfx colors', () => {
  it('parses accepted hex widths and rejects malformed digits', () => {
    expect(fromHex('#aBcD09')).toEqual([171, 205, 9])
    expect(fromHex('abcdef0')).toEqual([171, 205, 239])
    expect(fromHex('abc')).toBeNull()
    expect(fromHex('12345g')).toBeNull()
    expect(fromHex('12345')).toBeNull()
  })

  it('adjusts grayscale, red, green, and blue hues with clamped lightness', () => {
    expect(adjustBrightness([128, 128, 128], 1)).toEqual([128, 128, 128])
    expect(adjustBrightness([255, 0, 0], 0.5)).toEqual([128, 0, 0])
    expect(adjustBrightness([0, 255, 0], 0.5)).toEqual([0, 128, 0])
    expect(adjustBrightness([0, 0, 255], 0.5)).toEqual([0, 0, 128])
    expect(adjustBrightness([255, 64, 0], 1.5)[0]).toBeLessThanOrEqual(255)
    expect(adjustBrightness([255, 128, 32], 0.8)[1]).toBeGreaterThan(0)
    expect(adjustBrightness([255, 0, 128], 0.8)[2]).toBeGreaterThan(0)
    expect(adjustBrightness([0, 100, 255], -1)).toEqual([0, 0, 0])
    expect(adjustBrightness([255, 0, 128], 2)).toEqual([255, 255, 255])
  })

  it('builds, loops, clamps, and validates gradient spectra', () => {
    expect(Gradient.build([[10, 20, 30], [20, 40, 60], [30, 60, 90]], [2], true, false).spectrum).toEqual([
      [10, 20, 30], [15, 30, 45], [20, 40, 60], [25, 50, 75], [30, 60, 90],
    ])
    expect(Gradient.build([[10, 20, 30], [40, 50, 60]], [3, 4], true, true).spectrum.at(-1)).toEqual([10, 20, 30])
    expect(Gradient.build([[300, -20, 20], [300, -20, 20]], [2], true, false).spectrum[1]).toEqual([255, 0, 20])
    expect(Gradient.build([[1, 2, 3]], [2], true, false).spectrum).toEqual([[1, 2, 3], [1, 2, 3]])
    expect(() => Gradient.build([], [1], true, false)).toThrow()
    expect(() => Gradient.build([[1, 2, 3]], [], true, false)).toThrow()
    expect(() => Gradient.build([[1, 2, 3]], [0], true, false)).toThrow()
    expect(() => Gradient.build([[1, 2, 3], [4, 5, 6]], [0], false, false)).toThrow()
    expect(Gradient.build([[1, 2, 3], [4, 5, 6]], [2], false, false).spectrum).toHaveLength(3)
  })

  it('looks up fractions, maps four directions, and returns null outside the rectangle', () => {
    const gradient = Gradient.withSteps([[0, 0, 0], [255, 255, 255]], 4, false)
    expect(gradient.colorAtFraction(0)).toEqual([0, 0, 0])
    expect(gradient.colorAtFraction(0.5)).toEqual([126, 126, 126])
    expect(gradient.colorAtFraction(0.6)).toEqual([126, 126, 126])
    expect(gradient.colorAtFraction(1)).toEqual([255, 255, 255])
    expect(() => gradient.colorAtFraction(-0.1)).toThrow(RangeError)
    expect(() => gradient.colorAtFraction(1.1)).toThrow(RangeError)
    expect(() => new Gradient([]).colorAtFraction(0.5)).toThrow()
    expect(gradient.coordMap(1, 2, 1, 3, 'vertical').get(1, 2)).not.toBeNull()
    expect(gradient.coordMap(1, 2, 1, 3, 'horizontal').get(3, 1)).not.toBeNull()
    expect(gradient.coordMap(1, 2, 1, 3, 'diagonal').get(3, 2)).not.toBeNull()
    expect(gradient.coordMap(1, 2, 1, 3, 'radial').get(2, 1)).not.toBeNull()
    expect(gradient.coordMap(1, 2, 1, 3, 'vertical').get(0, 0)).toBeNull()
    expect(new GradientMap(1, 1, 1, 1, false, []).get(1, 1)).toBeNull()
    expect(gradient.coordMap(1, 1, 1, 3, 'vertical').get(1, 1)).not.toBeNull()
    expect(gradient.coordMap(1, 2, 1, 1, 'horizontal').get(1, 1)).not.toBeNull()
    expect(() => gradient.coordMap(1, 0, 1, 3, 'vertical')).toThrow()
    expect(() => gradient.coordMap(1, 2, 1, 0, 'vertical')).toThrow()
    expect(() => gradient.coordMap(2, 1, 1, 3, 'vertical')).toThrow()
    expect(() => gradient.coordMap(1, 2, 3, 1, 'vertical')).toThrow()
  })
})
