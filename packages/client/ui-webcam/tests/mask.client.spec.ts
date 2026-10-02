import { describe, expect, it } from 'vitest'
import { MASK_EMA_ALPHA, MASK_SIZE, personAlphaFromConfidence, stabilizeAlpha } from '../src/client/mask.js'

describe('personAlphaFromConfidence', () => {
  it('reads person confidence directly across all channels (no inversion)', () => {
    const confidence = new Float32Array(MASK_SIZE * MASK_SIZE)
    confidence[0] = 1 // full person
    confidence[1] = 0 // full background
    confidence[2] = 0.75 // mostly person
    confidence[3] = 1.5 // out-of-range confidence clamps to full person
    const frame = personAlphaFromConfidence(confidence)
    const alpha = (pixel: number): number[] => [frame[pixel * 4]!, frame[pixel * 4 + 1]!, frame[pixel * 4 + 2]!, frame[pixel * 4 + 3]!]
    // Every channel mirrors the person alpha: GL samples .r, and the 2D
    // fallback's destination-in cutout samples .a — same mask either way.
    expect(alpha(0)).toEqual([255, 255, 255, 255])
    expect(alpha(1)).toEqual([0, 0, 0, 0])
    expect(alpha(2)).toEqual([191, 191, 191, 191])
    expect(alpha(3)).toEqual([255, 255, 255, 255])
  })

  it('treats a short plane as erased, never fabricated person', () => {
    const frame = personAlphaFromConfidence(new Float32Array(2))
    expect(frame.length).toBe(MASK_SIZE * MASK_SIZE * 4)
    expect(frame[0]).toBe(0)
    expect(frame[frame.length - 1]).toBe(0)
  })

  it('produces a full MASK_SIZE² RGBA plane', () => {
    const frame = personAlphaFromConfidence(new Float32Array(MASK_SIZE * MASK_SIZE))
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
