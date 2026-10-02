import { describe, expect, it } from 'vitest'
import { MASK_EMA_ALPHA, MASK_SIZE, personAlphaFromBackground, stabilizeAlpha } from '../src/client/mask.js'

describe('personAlphaFromBackground', () => {
  it('inverts background confidence into person alpha across all channels', () => {
    const background = new Float32Array(MASK_SIZE * MASK_SIZE)
    background[0] = 0 // full person
    background[1] = 1 // full background
    background[2] = 0.25 // mostly person
    background[3] = 1.5 // out-of-range confidence clamps to no person
    const frame = personAlphaFromBackground(background)
    const alpha = (pixel: number): number[] => [frame[pixel * 4]!, frame[pixel * 4 + 1]!, frame[pixel * 4 + 2]!, frame[pixel * 4 + 3]!]
    // Every channel mirrors the person alpha: GL samples .r, and the 2D
    // fallback's destination-in cutout samples .a — same mask either way.
    expect(alpha(0)).toEqual([255, 255, 255, 255])
    expect(alpha(1)).toEqual([0, 0, 0, 0])
    expect(alpha(2)).toEqual([191, 191, 191, 191])
    expect(alpha(3)).toEqual([0, 0, 0, 0])
  })

  it('produces a full MASK_SIZE² RGBA plane', () => {
    const frame = personAlphaFromBackground(new Float32Array(MASK_SIZE * MASK_SIZE))
    expect(frame.length).toBe(MASK_SIZE * MASK_SIZE * 4)
  })
})

describe('stabilizeAlpha', () => {
  it('seeds the first frame at full opacity, then blends at the EMA weight', () => {
    expect(stabilizeAlpha(false)).toBe(1)
    expect(stabilizeAlpha(true)).toBe(MASK_EMA_ALPHA)
    expect(MASK_EMA_ALPHA).toBeGreaterThan(0)
    expect(MASK_EMA_ALPHA).toBeLessThan(1)
  })
})
